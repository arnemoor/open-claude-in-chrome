// Unit tests for extension/audit/redact.js — loaded standalone into a vm context
// (no chrome.* needed: these are pure functions over tool args).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const FILE = path.join(import.meta.dirname, "..", "extension", "audit", "redact.js");

function load() {
  const ctx = vm.createContext({ URL });
  vm.runInContext(fs.readFileSync(FILE, "utf8"), ctx, { filename: "redact.js" });
  return {
    auditSummary: vm.runInContext("auditSummary", ctx),
    redactUrl: vm.runInContext("redactUrl", ctx),
    scrubUrls: vm.runInContext("scrubUrls", ctx),
  };
}

// --- computer ---

test("computer type never contains the typed text, only its length", () => {
  const { auditSummary } = load();
  const s = auditSummary("computer", { action: "type", text: "hunter2" });
  assert.doesNotMatch(s, /hunter2/);
  assert.equal(s, "type [7 chars]");
});

test("computer click reports the action, coordinate and ref", () => {
  const { auditSummary } = load();
  assert.equal(auditSummary("computer", { action: "left_click", coordinate: [10, 20] }), "left_click at (10, 20)");
  assert.equal(auditSummary("computer", { action: "left_click", ref: "ref_3" }), "left_click ref_3");
});

test("computer key keeps named keys and modifier combos", () => {
  const { auditSummary } = load();
  assert.equal(auditSummary("computer", { action: "key", text: "ctrl+a" }), "key ctrl+a");
  assert.equal(auditSummary("computer", { action: "key", text: "cmd+shift+t" }), "key cmd+shift+t");
  assert.equal(auditSummary("computer", { action: "key", text: "Enter Tab Escape" }), "key Enter Tab Escape");
});

// I5 ruling: bare single printable characters are how `key` types text one
// character at a time, bypassing `type`'s own redaction — so they must never
// survive verbatim either.
test("computer key never leaks text typed as a run of bare characters (I5)", () => {
  const { auditSummary } = load();
  const s = auditSummary("computer", { action: "key", text: "h u n t e r 2" });
  assert.doesNotMatch(s, /hunter/);
  assert.equal(s, "key [7 keys]");
});

test("computer key replaces each bare-character run inside a mixed sequence with a count", () => {
  const { auditSummary } = load();
  const s = auditSummary("computer", { action: "key", text: "ctrl+a h u n t e r Delete" });
  assert.doesNotMatch(s, /hunter/);
  assert.equal(s, "key ctrl+a [6 keys] Delete");
});

test("computer scroll keeps direction and amount", () => {
  const { auditSummary } = load();
  const s = auditSummary("computer", { action: "scroll", coordinate: [5, 5], scroll_direction: "up", scroll_amount: 4 });
  assert.match(s, /^scroll at \(5, 5\) up 4$/);
});

test("computer zoom keeps the region", () => {
  const { auditSummary } = load();
  const s = auditSummary("computer", { action: "zoom", region: [1, 2, 3, 4] });
  assert.match(s, /^zoom region \[1, 2, 3, 4\]$/);
});

// M4: a non-array region must not throw — the action still gets recorded.
test("computer zoom with a non-array region does not throw", () => {
  const { auditSummary } = load();
  assert.doesNotThrow(() => auditSummary("computer", { action: "zoom", region: "not-an-array" }));
  assert.match(auditSummary("computer", { action: "zoom", region: "not-an-array" }), /^zoom/);
});

// --- navigate ---

test("navigate back/forward pass through as-is", () => {
  const { auditSummary } = load();
  assert.equal(auditSummary("navigate", { url: "back" }), "back");
  assert.equal(auditSummary("navigate", { url: "forward" }), "forward");
});

test("navigate to a data: URL never leaks the payload", () => {
  const { auditSummary } = load();
  const url = "data:text/html,<script>alert(1)</script>";
  const s = auditSummary("navigate", { url });
  assert.doesNotMatch(s, /alert/);
  assert.equal(s, `data:[${url.length} chars]`);
});

// M3: the data: rule must match case-insensitively and after trimming.
test("navigate to a data: URL is recognized regardless of case or leading whitespace", () => {
  const { auditSummary } = load();
  const upper = "DATA:text/html,<p>apikey=XYZ</p>";
  const padded = "  data:text/html,<p>apikey=XYZ</p>";
  assert.equal(auditSummary("navigate", { url: upper }), `data:[${upper.length} chars]`);
  assert.equal(auditSummary("navigate", { url: padded }), `data:[${padded.length} chars]`);
});

test("navigate to a normal URL is redacted via redactUrl", () => {
  const { auditSummary } = load();
  assert.equal(auditSummary("navigate", { url: "https://x.test/reset?token=abc#frag" }), "https://x.test/reset?…#…");
});

// M4: the navigate handler prepends https:// to scheme-less input before ever
// touching the browser, so the audit summary must mirror that or the recorded
// destination is a nonsense scheme (e.g. "localhost://3000/x").
test("navigate to scheme-less input is redacted as the handler will actually navigate it", () => {
  const { auditSummary } = load();
  assert.equal(auditSummary("navigate", { url: "bank.test/reset?token=abc" }), "https://bank.test/reset?…");
  assert.equal(auditSummary("navigate", { url: "localhost:3000/x" }), "https://localhost:3000/x");
});

test("navigate keeps about:/chrome:/brave: schemes unprefixed", () => {
  const { auditSummary } = load();
  assert.equal(auditSummary("navigate", { url: "about:blank" }), "about:blank");
  assert.equal(auditSummary("navigate", { url: "chrome://settings" }), "chrome://settings");
});

test("redactUrl strips query and fragment but keeps origin and path", () => {
  const { redactUrl } = load();
  assert.equal(redactUrl("https://x.test/reset?token=abc#frag"), "https://x.test/reset?…#…");
  assert.equal(redactUrl("https://x.test/plain"), "https://x.test/plain");
});

// M4: redactUrl must not corrupt a URL whose scheme the WHATWG parser treats as
// "not special" (no double-slash host syntax) — it must not synthesize a bogus
// "scheme://" prefix for a URL that never had one.
test("redactUrl leaves a non-special scheme's shape intact", () => {
  const { redactUrl } = load();
  assert.equal(redactUrl("about:blank"), "about:blank");
});

test("redactUrl strips userinfo (credentials in the URL itself)", () => {
  const { redactUrl } = load();
  assert.equal(redactUrl("https://user:pa55@host.test/p?q=1"), "https://host.test/p?…");
});

test("redactUrl keeps a lone fragment marked, with no query marker", () => {
  const { redactUrl } = load();
  assert.equal(redactUrl("https://x.test/page#secret-token"), "https://x.test/page#…");
});

test("redactUrl reports unparsable input without echoing it", () => {
  const { redactUrl } = load();
  assert.equal(redactUrl("not a url at all"), "[unparseable url]");
  assert.equal(redactUrl(undefined), "[unparseable url]");
});

// --- form_input ---

test("form_input never leaks a string value, e.g. a credit card number", () => {
  const { auditSummary } = load();
  const value = "4111 1111 1111 1111";
  const s = auditSummary("form_input", { ref: "ref_5", value });
  assert.doesNotMatch(s, /4111/);
  assert.match(s, /^ref_5 value \[\d+ chars\]$/);
});

test("form_input keeps booleans and numbers without the raw value shape being ambiguous", () => {
  const { auditSummary } = load();
  assert.equal(auditSummary("form_input", { ref: "ref_1", value: true }), "ref_1 checked=true");
  assert.equal(auditSummary("form_input", { ref: "ref_1", value: false }), "ref_1 checked=false");
  assert.equal(auditSummary("form_input", { ref: "ref_2", value: 42 }), "ref_2 value [number]");
});

// --- javascript_tool ---

test("javascript_tool keeps short code as-is", () => {
  const { auditSummary } = load();
  assert.equal(auditSummary("javascript_tool", { text: "1+1" }), "1+1");
});

test("javascript_tool clips code over 500 chars and reports the overflow", () => {
  const { auditSummary } = load();
  const code = "x".repeat(600);
  const s = auditSummary("javascript_tool", { text: code });
  assert.match(s, /… \(\+100 chars\)$/);
  assert.equal(s.slice(0, 500), "x".repeat(500));
});

// I5: string/template literal contents are exactly where a script would carry a
// typed secret (a form value assignment, a fetch header, a password check).
test("javascript_tool masks string literal contents but keeps the surrounding code", () => {
  const { auditSummary } = load();
  const code = "document.querySelector('#pw').value = 'S3cr3t!'; document.forms[0].submit()";
  const s = auditSummary("javascript_tool", { text: code });
  assert.doesNotMatch(s, /S3cr3t/);
  assert.equal(s, "document.querySelector('[3 chars]').value = '[7 chars]'; document.forms[0].submit()");
});

test("javascript_tool masks double-quoted and template literal contents, honoring escapes", () => {
  const { auditSummary } = load();
  const s1 = auditSummary("javascript_tool", { text: `fetch("https://x", {headers:{Authorization: "Bearer abc"}})` });
  assert.doesNotMatch(s1, /Bearer abc/);
  const s2 = auditSummary("javascript_tool", { text: "const t = `Bearer ${token}`;" });
  assert.doesNotMatch(s2, /token/);
  assert.match(s2, /^const t = `\[\d+ chars\]`;$/);
  // an escaped quote inside a literal must not end it early
  const s3 = auditSummary("javascript_tool", { text: `x = 'it\\'s a secret'` });
  assert.doesNotMatch(s3, /secret/);
});

// --- file_upload ---

test("file_upload keeps paths, since they are audit-relevant", () => {
  const { auditSummary } = load();
  const s = auditSummary("file_upload", { ref: "ref_9", paths: ["/tmp/a.pdf", "/tmp/b.pdf"] });
  assert.equal(s, "ref_9 paths: /tmp/a.pdf, /tmp/b.pdf");
});

// --- find ---

test("find keeps the query", () => {
  const { auditSummary } = load();
  assert.equal(auditSummary("find", { query: "Submit button" }), "query: Submit button");
});

// --- upload_image ---

test("upload_image keeps imageId and ref", () => {
  const { auditSummary } = load();
  assert.equal(auditSummary("upload_image", { imageId: "screenshot_1", ref: "ref_4" }), "imageId screenshot_1 ref_4");
});

// M4: upload_image can be called by coordinate instead of ref; the summary must
// show where it went, not the literal word "undefined".
test("upload_image by coordinate shows the coordinate, not undefined", () => {
  const { auditSummary } = load();
  const s = auditSummary("upload_image", { imageId: "screenshot_1", coordinate: [10, 20] });
  assert.doesNotMatch(s, /undefined/);
  assert.equal(s, "imageId screenshot_1 at (10, 20)");
});

// --- browser_batch ---

test("browser_batch summarizes the count and nested tool names, not their args", () => {
  const { auditSummary } = load();
  const s = auditSummary("browser_batch", {
    actions: [{ name: "navigate", input: { url: "https://secret.test/token=abc" } }, { name: "computer", input: { action: "type", text: "hunter2" } }],
  });
  assert.equal(s, "batch of 2: navigate, computer");
  assert.doesNotMatch(s, /secret|hunter2/);
});

// --- everything else ---

test("an unlisted tool falls back to a clipped JSON of its args, minus tabId", () => {
  const { auditSummary } = load();
  const s = auditSummary("resize_window", { width: 800, height: 600, tabId: 11 });
  assert.doesNotMatch(s, /tabId/);
  assert.equal(s, JSON.stringify({ width: 800, height: 600 }));
});

test("the generic fallback clips long strings inside args to 100 chars", () => {
  const { auditSummary } = load();
  const long = "y".repeat(150);
  const s = auditSummary("read_console_messages", { pattern: long, tabId: 1 });
  const parsed = JSON.parse(s.endsWith("…") ? s.slice(0, -1) : s);
  assert.ok(parsed.pattern.length <= 101);
});

test("the generic fallback clips its total output to 300 chars", () => {
  const { auditSummary } = load();
  const s = auditSummary("get_page_text", { a: "z".repeat(50), b: "z".repeat(50), c: "z".repeat(50), d: "z".repeat(50), e: "z".repeat(50), f: "z".repeat(50), g: "z".repeat(50) });
  assert.ok(s.length <= 301);
  assert.match(s, /…$/);
});

// M9: the generic fallback must scrub URL-like tokens too (read_network_requests'
// urlPattern, for example), not just clip their length.
test("the generic fallback scrubs a URL's query string, not just its length", () => {
  const { auditSummary } = load();
  const s = auditSummary("read_network_requests", { urlPattern: "https://api.x.test/v1?token=abc", tabId: 1 });
  assert.doesNotMatch(s, /token=abc/);
});

// --- I1: outcome/error text must never carry a page URL's query or fragment ---

test("scrubUrls redacts every URL-like token in free text and clips to 200 chars", () => {
  const { scrubUrls } = load();
  const msg = 'Cannot access contents of url "https://bank.test/reset?token=SECRET123#access_token=FRAG456". Extension manifest must request permission to access this host.';
  const s = scrubUrls(msg, 200);
  assert.doesNotMatch(s, /SECRET123/);
  assert.doesNotMatch(s, /FRAG456/);
  assert.match(s, /"https:\/\/bank\.test\/reset\?…#…"/);
  assert.ok(s.length <= 201);
});

test("scrubUrls leaves plain text with no URL untouched (aside from clipping)", () => {
  const { scrubUrls } = load();
  assert.equal(scrubUrls("Not attached to tab", 200), "Not attached to tab");
});

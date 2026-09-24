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

test("computer key keeps the key names", () => {
  const { auditSummary } = load();
  assert.equal(auditSummary("computer", { action: "key", text: "ctrl+a" }), "key ctrl+a");
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

test("navigate to a normal URL is redacted via redactUrl", () => {
  const { auditSummary } = load();
  assert.equal(auditSummary("navigate", { url: "https://x.test/reset?token=abc#frag" }), "https://x.test/reset?…#…");
});

test("redactUrl strips query and fragment but keeps origin and path", () => {
  const { redactUrl } = load();
  assert.equal(redactUrl("https://x.test/reset?token=abc#frag"), "https://x.test/reset?…#…");
  assert.equal(redactUrl("https://x.test/plain"), "https://x.test/plain");
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

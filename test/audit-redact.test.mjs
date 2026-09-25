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
    redactEvents: vm.runInContext("redactEvents", ctx),
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

// Item 8: shift + one printable character types real text (a capital letter,
// or a shifted symbol), one key call at a time — the same bypass as I5's bare
// characters, just with shift held. Count it like a bare character.
test("computer key: shift plus one printable character counts like a bare character (item 8)", () => {
  const { auditSummary } = load();
  const s = auditSummary("computer", { action: "key", text: "shift+h shift+i" });
  assert.doesNotMatch(s, /shift\+h|shift\+i/);
  assert.equal(s, "key [2 keys]");
});

test("computer key: a shift+char run inside a mixed sequence is counted, a real modifier combo is kept", () => {
  const { auditSummary } = load();
  const s = auditSummary("computer", { action: "key", text: "ctrl+a shift+h shift+i Delete" });
  assert.equal(s, "key ctrl+a [2 keys] Delete");
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

// Fix round 2, T15 I5 (partial): a quote inside a comment or a regex literal
// used to desynchronize the scanner, so a later, real string literal was
// emitted as code instead of masked.
test("javascript_tool: an apostrophe inside a // comment does not desynchronize the scanner", () => {
  const { auditSummary } = load();
  const code = "// fill in the user's password\ndocument.querySelector('#pw').value = 'S3cr3tA';";
  const s = auditSummary("javascript_tool", { text: code });
  assert.doesNotMatch(s, /S3cr3tA/);
  assert.match(s, /^\/\/ fill in the user's password\n/, "the comment itself must survive verbatim");
});

test("javascript_tool: an apostrophe inside a /* */ block comment does not desynchronize the scanner", () => {
  const { auditSummary } = load();
  const code = "/* the user's token */ pw.value = 'S3cr3tB';";
  const s = auditSummary("javascript_tool", { text: code });
  assert.doesNotMatch(s, /S3cr3tB/);
  assert.match(s, /^\/\* the user's token \*\/ /);
});

// Fix round 3, item 1: the regex-vs-division heuristic itself was the bug — 13
// of 61 adversarial inputs still leaked a later string literal through it (a
// postfix ++/-- before a "/", or a "/" after if(...)/while(...)/await/...).
// The ruling replaced guessing with a fail-closed rule: outside a string,
// template or comment, ANY "/" that isn't "//" or "/*" ends the kept part —
// everything from that "/" to the end of input becomes one [N chars] span.
// This over-masks a real regex or a real division, but it can no longer
// leak, no matter how the "/" was introduced.
test("javascript_tool: a bare / (division or otherwise) masks everything from there to the end", () => {
  const { auditSummary } = load();
  const s = auditSummary("javascript_tool", { text: "let a = width / 2; let b = 'secret';" });
  assert.doesNotMatch(s, /secret/);
  assert.match(s, /^let a = width \[\d+ chars\]$/);
});

// Fix round 4, item 6: all 61 adversarial inputs of the round-2 re-review,
// transcribed unaltered with their secret patterns. P2-P7 and K1-K7 leaked
// through the old regex-vs-division heuristic.
const NO_LEAK_CASES = [
  ["C1 apostrophe in // comment", "// fill in the user's password\ndocument.querySelector('#pw').value = 'S3cr3tA';", /S3cr3tA/],
  ["C2 apostrophe in /* */", "/* the user's token */ pw.value = 'S3cr3tB';", /S3cr3tB/],
  ["C3 dquote in /* */", '/* say "hi */ x = "S3cr3tC";', /S3cr3tC/],
  ["C4 backtick in /* */", "/* a ` b */ x = `S3cr3tD`;", /S3cr3tD/],
  ["C5 quote in // inside ${}", "x = `${ a // it's\n }S3cr3tE`; y = 'S3cr3tF';", /S3cr3tE|S3cr3tF/],
  ["R1 regex after return", "function f(s){ return /'/.test(s) } pw.value = 'S3cr3tG';", /S3cr3tG/],
  ["R2 regex after (", "s = s.replace(/'/g, \"\"); x = 'S3cr3tH';", /S3cr3tH/],
  ["R3 regex after =", "const re = /\"/g; x = \"S3cr3tI\";", /S3cr3tI/],
  ["R4 regex after ,", "f(a, /'/g, 'S3cr3tJ');", /S3cr3tJ/],
  ["R5 regex after =>", "g = s => /'/.test(s); y = 'S3cr3tK';", /S3cr3tK/],
  ["R6 regex after typeof", "t = typeof /'/; y = 'S3cr3tL';", /S3cr3tL/],
  ["R7 regex class with / and quotes", "m = s.match(/[/'\"]/g); y = 'S3cr3tM';", /S3cr3tM/],
  ["R8 regex with escaped /", "m = s.match(/\\/'/g); y = 'S3cr3tN';", /S3cr3tN/],
  ["R9 regex after }", "function f(){}\n/'/.test(s); y = 'S3cr3tO';", /S3cr3tO/],
  ["R10 regex after : (object)", "o = {re: /'/g, pw: 'S3cr3tP'};", /S3cr3tP/],
  ["R11 regex after &&", "ok && /'/.test(s) && (pw = 'S3cr3tQ');", /S3cr3tQ/],
  ["R12 regex after !", "if (!/'/.test(s)) pw = 'S3cr3tR';", /S3cr3tR/],
  ["D1 division after )", "x = (a + b) / 2; y = 'S3cr3tS';", /S3cr3tS/],
  ["D2 division after ) then string with /", "x = (a + b) / 2; y = 'a/b'; z = 'S3cr3tT';", /S3cr3tT/],
  ["D3 division after ]", "x = arr[0] / 2; y = 'a/b'; z = 'S3cr3tU';", /S3cr3tU/],
  ["D4 division after number", "x = 10 / 2; y = 'a/b'; z = 'S3cr3tV';", /S3cr3tV/],
  ["D5 division after string", "x = 'a' / 2; y = 'c/d'; z = 'S3cr3tW';", /S3cr3tW/],
  ["D6 /= after ident", "x /= 2; y = 'a/b'; z = 'S3cr3tX';", /S3cr3tX/],
  ["D7 division with comment between", "x = a /* c */ / 2; y = 'a/b'; z = 'S3cr3tY';", /S3cr3tY/],
  ["P1 a++ / 'x' / 'S'", "r = a++ / 'x' / 'S3cr3tP1';", /S3cr3tP1/],
  ["P2 a++ / 'x/' + 'S'", "r = a++ / 'x/' + 'S3cr3tP2';", /S3cr3tP2/],
  ["P3 i++ / 2; split('/')", "r = i++ / 2; parts = s.split('/'); pw = 'S3cr3tP3';", /S3cr3tP3/],
  ["P4 done++ / total; '/api'", "pct = done++ / total; url = base + '/api/login'; fetch(url, {body: 'password=S3cr3tP4'});", /S3cr3tP4/],
  ["P5 n-- / 2 then 'x/SECRET'", "r = n-- / 2; s = 'x/S3cr3tP5';", /S3cr3tP5/],
  ["P6 a++ / 2 then // comment with slash+apostrophe", "r = a++ / 2; // done/it's\npw = 'S3cr3tP6';", /S3cr3tP6/],
  ["P7 i++ / 2 multi-line", "r = i++ / 2;\nconst u = '/v1/users';\nconst pw = 'S3cr3tP7';", /S3cr3tP7/],
  ["E1 escaped backslash at string end", "x = 'abc\\\\'; y = 'S3cr3tE1';", /S3cr3tE1/],
  ["E2 escaped dquote", 'x = "a\\"b"; y = "S3cr3tE2";', /S3cr3tE2/],
  ["E3 escaped backslash then escaped quote", "x = 'a\\\\\\'b'; y = 'S3cr3tE3';", /S3cr3tE3/],
  ["E4 trailing backslash at input end", "x = 'S3cr3tE4\\", /S3cr3tE4/],
  ["E5 escaped backtick in template", "x = `a\\`b`; y = 'S3cr3tE5';", /S3cr3tE5/],
  ["E6 backslash at end of template", "x = `a\\\\`; y = 'S3cr3tE6';", /S3cr3tE6/],
  ["T1 ${} with '}' string", "x = `a ${'}'} b S3cr3tT1`;", /S3cr3tT1/],
  ["T2 ${} with backtick in string", "x = `${\"`\"}S3cr3tT2`; y = 'S3cr3tT2b';", /S3cr3tT2/],
  ["T3 ${} with object literal", "x = `${ {a: 1}.a } S3cr3tT3`; y = 'S3cr3tT3b';", /S3cr3tT3/],
  ["T4 ${} with nested braces", "x = `${ JSON.stringify({a: {b: 'c'}}) } S3cr3tT4`; y = 'S3cr3tT4b';", /S3cr3tT4/],
  ["T5 nested templates x3", "x = `${ `${ `S3cr3tT5` }` }`; y = 'S3cr3tT5b';", /S3cr3tT5/],
  ["T6 ${} with regex containing }", "x = `${ s.replace(/}/g, '') }S3cr3tT6`; y = 'S3cr3tT6b';", /S3cr3tT6/],
  ["T7 ${} with ++ division", "x = `${i++ / 2}` + '/' + 'S3cr3tT7';", /S3cr3tT7/],
  ["T8 ${} with block comment containing }", "x = `${ a /* } */ }S3cr3tT8`; y = 'S3cr3tT8b';", /S3cr3tT8/],
  ["T9 template after template", "x = `a` + `S3cr3tT9`;", /S3cr3tT9/],
  ["T10 ${} string with ${", "x = `${ '${' }S3cr3tT10`; y='S3cr3tT10b';", /S3cr3tT10/],
  ["U1 unterminated string", "pw.value = 'never closes S3cr3tU1", /S3cr3tU1/],
  ["U2 unterminated template", "x = `S3cr3tU2 ${a}", /S3cr3tU2/],
  ["U3 unterminated regex", "x = /S3cr3tU3", /S3cr3tU3/],
  ["U4 unterminated block comment", "/* S3cr3tU4", /S3cr3tU4/],
  ["U5 unterminated ${", "x = `${ 'a' + S3cr3tU5", /S3cr3tU5/],
  ["U6 unterminated string in ${", "x = `${ 'S3cr3tU6 }`", /S3cr3tU6/],
  ["K1 regex after ) of if", "if (ok) /'/.test(s); pw = 'S3cr3tK1';", /S3cr3tK1/],
  ["K2 division after {} (obj)", "x = {} / 2; y = 'a/b'; z = 'S3cr3tK2';", /S3cr3tK2/],
  ["K3 of as identifier", "let of = 4; x = of / 2; s = 'a/b'; t = 'S3cr3tK3';", /S3cr3tK3/],
  ["K4 .in property division", "x = r.in / 2; s = 'a/b'; t = 'S3cr3tK4';", /S3cr3tK4/],
  ["K5 await regex", "async () => { await /'/; pw = 'S3cr3tK5'; }", /S3cr3tK5/],
  ["K6 regex after ... spread", "a = [.../'/g.exec(s)]; pw = 'S3cr3tK6';", /S3cr3tK6/],
  ["K7 regex after ) with dquote", 'while (x) /"/.exec(s); pw = "S3cr3tK7";', /S3cr3tK7/],
  ["K8 regex after ++ (prefix)", "x = ++i / 2; y = 'a/b'; z = 'S3cr3tK8';", /S3cr3tK8/],
];
test("javascript_tool: the adversarial table holds all 61 inputs", () => {
  assert.equal(NO_LEAK_CASES.length, 61);
});
for (const [label, code, secret] of NO_LEAK_CASES) {
  test(`javascript_tool: ${label} does not leak its secret literal`, () => {
    const { auditSummary } = load();
    assert.doesNotMatch(auditSummary("javascript_tool", { text: code }), secret);
  });
}

test("javascript_tool: a template literal nested inside another's ${} does not leak", () => {
  const { auditSummary } = load();
  const s = auditSummary("javascript_tool", { text: "const h = `Authorization: ${`Bearer S3cr3tE`}`;" });
  assert.doesNotMatch(s, /S3cr3tE/);
});

test("javascript_tool: a comment with a quote inside a template's ${} substitution does not corrupt what follows it", () => {
  const { auditSummary } = load();
  const code = "const h = `outer ${ // it's a comment\n 'value' }`; console.log('AFTER');";
  const s = auditSummary("javascript_tool", { text: code });
  assert.doesNotMatch(s, /AFTER/);
  assert.match(s, /console\.log\('\[\d+ chars\]'\);$/, "expected normal code to resume correctly once the template closed");
});

test("javascript_tool: an unterminated string is masked to the end, not echoed as code", () => {
  const { auditSummary } = load();
  const s = auditSummary("javascript_tool", { text: `pw.value = 'never closes and the rest of the file is EOFSECRET` });
  assert.doesNotMatch(s, /EOFSECRET/);
  assert.match(s, /^pw\.value = '\[\d+ chars\]$/);
});

test("javascript_tool: an unterminated block comment fails closed instead of echoing what follows", () => {
  const { auditSummary } = load();
  const s = auditSummary("javascript_tool", { text: "/* never closes and the rest of the file is EOFSECRET" });
  assert.doesNotMatch(s, /EOFSECRET/);
  assert.match(s, /^\/\*\[\d+ chars\]$/);
});

function nestedTemplates(levels, inner) {
  return "x = " + "`a${".repeat(levels) + inner + "}`".repeat(levels) + "; y = 'S3cr3tAfter';";
}

// Fix round 4, item 6: the cap counts template levels, as ruled. Round 3
// pushed two stack frames per level and compared the stack length with 100,
// so it failed closed from level 51.
test("javascript_tool: 100 nested template levels still close, the 101st fails closed", () => {
  const { auditSummary } = load();
  assert.match(auditSummary("javascript_tool", { text: nestedTemplates(100, "1") }), /^x = `\[\d+ chars\]`; y = '\[11 chars\]';$/);
  assert.match(auditSummary("javascript_tool", { text: nestedTemplates(101, "1") }), /^x = `\[\d+ chars\]$/);
});

// The recursive scanner of round 2 threw a RangeError at 10,000 levels, which
// dropped the whole action from the log.
test("javascript_tool: 20,000 nested template levels neither throw nor leak", () => {
  const { auditSummary } = load();
  let s;
  assert.doesNotThrow(() => { s = auditSummary("javascript_tool", { text: nestedTemplates(20000, "'SECRET_AT_BOTTOM'") }); });
  assert.doesNotMatch(s, /SECRET_AT_BOTTOM|S3cr3tAfter/);
});

// Fix round 4, item 4: JavaScript also ends a line at CR, U+2028 and U+2029.
// A // comment that ran on to the next LF hid real code from the scanner: at
// the top level a string after the line end was echoed, and inside ${} the
// template seemed to close at a later backtick, so the text after it was
// echoed as code.
for (const [name, eol] of [["LF", "\n"], ["CR", "\r"], ["U+2028", "\u2028"], ["U+2029", "\u2029"]]) {
  test(`javascript_tool: a // comment ends at ${name}`, () => {
    const { auditSummary } = load();
    assert.equal(auditSummary("javascript_tool", { text: `// note${eol}pw = 'S3CR1';` }), `// note${eol}pw = '[5 chars]';`);
  });

  test(`javascript_tool: a // comment inside \${} ends at ${name}`, () => {
    const { auditSummary } = load();
    const code = "x = `${ a // note" + eol + " }`; function g() {\n}; s = `S3CR2`;";
    const templateLength = code.indexOf("`;") - 5;
    assert.equal(auditSummary("javascript_tool", { text: code }), "x = `[" + templateLength + " chars]`; function g() {\n}; s = `[5 chars]`;");
  });
}

test("javascript_tool: a plain snippet with no / anywhere keeps its exact code structure", () => {
  const { auditSummary } = load();
  const code = "function greet(name) { return `Hello, ${name}!`; }";
  const s = auditSummary("javascript_tool", { text: code });
  assert.match(s, /^function greet\(name\) \{ return `\[\d+ chars\]`; \}$/);
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

// Fix round 2, pulled in from the re-review: scrubUrls used to stop matching a
// URL at ")" or "'", both of which are valid, unencoded query/fragment
// characters — so a query like "?code=abc)SECRET" kept "SECRET" verbatim.
test("scrubUrls consumes ) and ' inside a query or fragment, not just up to them", () => {
  const { scrubUrls } = load();
  const s = scrubUrls('Cannot access "https://bank.test/cb?code=abc)PARENSECRET#frag\'more"', 300);
  assert.doesNotMatch(s, /PARENSECRET/);
  assert.equal(s, 'Cannot access "https://bank.test/cb?…#…"');
});

// Fix round 4, item 1: round 3 took "?" and "#" out of the host/path run but
// left "'" in it, so a quote in a query or fragment ended the whole token and
// the rest of the query stayed in the text.
test("scrubUrls: a ' inside a query or fragment does not end the URL token", () => {
  const { scrubUrls } = load();
  assert.equal(scrubUrls("https://x.test/s?q=it's&token=APOSQ2"), "https://x.test/s?…");
  assert.equal(scrubUrls("https://x.test/p#state=a'APOSF1"), "https://x.test/p#…");
});

test("scrubUrls: a ' still ends a URL before any query, e.g. a URL in single quotes", () => {
  const { scrubUrls } = load();
  assert.equal(scrubUrls("open 'https://x.test/p' now"), "open 'https://x.test/p' now");
});

test("scrubUrls still stops a bare URL (no query) at a closing paren, e.g. a parenthetical", () => {
  const { scrubUrls } = load();
  const s = scrubUrls("(see https://x.test/page)", 300);
  assert.equal(s, "(see https://x.test/page)");
});

test("scrubUrls replaces a data: URL with its length, the same way navigate's own data: rule does", () => {
  const { scrubUrls } = load();
  const s = scrubUrls("failed to load data:text/html,<p>apikey=SECRET123</p> here", 300);
  assert.doesNotMatch(s, /SECRET123/);
  // Fix round 3, item 3: masked to the true end of the value (nothing here
  // quotes or otherwise bounds it), so the trailing " here" is absorbed too —
  // not left exposed after a truncated match, which is exactly the residual
  // this item closed (see the "data: URL containing a space" test below).
  assert.match(s, /^failed to load data:\[\d+ chars\]$/);
});

// Fix round 3, item 3 (pulled): "(" used to end the host/path part, so a URL
// containing one before its query kept that query in the clear.
test("scrubUrls (item 3): a ( in the path no longer ends the match before it reaches the query", () => {
  const { scrubUrls } = load();
  const s = scrubUrls("see https://x.test/a(b?token=PARENPATH1 for details", 300);
  assert.doesNotMatch(s, /PARENPATH1/);
});

// A URL token now ends only at whitespace, a quote, < or > — a bare URL (no
// query) still doesn't swallow unrelated trailing text once whitespace hits.
test("scrubUrls (item 3): a bare URL still stops at whitespace before unrelated trailing text", () => {
  const { scrubUrls } = load();
  const s = scrubUrls("(see https://x.test/page) more text", 300);
  assert.match(s, /more text$/);
});

// Fix round 3, item 3 (pulled): a data: URL containing a space used to stop
// there, leaving the rest of the payload (e.g. HTML text content) exposed.
test("scrubUrls (item 3): a data: URL containing a space is masked to the end of the value, not just to the space", () => {
  const { scrubUrls } = load();
  const s = scrubUrls("data:text/html,<p>my password is DATASPACE1</p>", 300);
  assert.doesNotMatch(s, /DATASPACE1/);
});

// Fix round 4, item 3: a data: payload can hold any character, so a quote in
// it does not end the mask either. It runs to the end of the value.
test("scrubUrls: a data: URL is masked to the end of the value, past any quote in its payload", () => {
  const { scrubUrls } = load();
  const apos = "data:text/html,<p>it's DATAAPOS1</p>";
  assert.equal(scrubUrls(apos), `data:[${apos.length} chars]`);
  const prefix = 'Cannot access "';
  const quoted = `${prefix}data:text/html,<a href="x">DATAQUOT1</a>" here`;
  assert.equal(scrubUrls(quoted), `${prefix}data:[${quoted.length - prefix.length} chars]`);
});

// Fix round 3, item 2 (new Important): URL_TOKEN_RE's unbounded scheme part
// backtracked quadratically once it started running over every page
// attribute (I2's walker), not just short error texts — a 100 KB attribute
// cost 4.1s. The reviewer's worst case: a long run alternating a word
// character and a non-word character (each "a" is its own \b anchor point),
// with no ":" anywhere to let the scheme part ever succeed.
test("scrubUrls (item 2): a long, colon-less run does not backtrack quadratically", () => {
  const { scrubUrls } = load();
  const input = "a.".repeat(500_000); // ~1 MB, the reviewer's worst case
  const start = Date.now();
  scrubUrls(input, 300);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 200, `expected under 200ms, took ${elapsed}ms (quadratic regex backtracking regression?)`);
});

// Item 7: a "'" in the host/path part (before any query) used to end the
// token right there, leaving the query — and any secret in it — in the
// clear. "'" only ever over-masks, so it now stays in the token the same way
// "(" and ")" already do.
test("scrubUrls (item 7): a ' in the path before the query does not leak the query", () => {
  const { scrubUrls } = load();
  const s = scrubUrls("see https://x.test/o'brien?token=APOSPATH1 for details", 300);
  assert.doesNotMatch(s, /APOSPATH1/);
});

// --- redactEvents (I1/I2): the worker-side walker over rrweb event batches, run
// in Audit.onRecorderEvents before anything is stored, so a recorder in any
// document cannot bypass it. `knownTags` is a Map the caller (audit.js) keeps
// per tab across batches, since a node's defining snapshot/add can arrive in an
// earlier batch than a later attribute mutation on the same node. ---

function inputNode(id, attributes) {
  return { type: 2, tagName: "input", attributes, id, childNodes: [] };
}

test("I1: a hidden input's raw value in the full snapshot is masked", () => {
  const { redactEvents } = load();
  const events = [{
    type: 2,
    data: { node: { type: 0, id: 1, childNodes: [{ type: 2, tagName: "body", attributes: {}, id: 7, childNodes: [inputNode(8, { type: "hidden", name: "csrf", value: "HIDDENLOAD111" })] }] } },
    timestamp: 1,
  }];
  redactEvents(events, new Map());
  const json = JSON.stringify(events);
  assert.doesNotMatch(json, /HIDDENLOAD111/);
  assert.equal(events[0].data.node.childNodes[0].childNodes[0].attributes.value, "*".repeat("HIDDENLOAD111".length));
});

// I1's core gap: rrweb only overwrites `value` with the masked live value when
// the live value is non-empty, so a field cleared by script after being
// prefilled in markup keeps its raw HTML attribute untouched by rrweb itself.
test("I1: a cleared password field's raw value attribute is masked even though rrweb's own masking never touched it", () => {
  const { redactEvents } = load();
  const events = [{
    type: 2,
    data: { node: { type: 0, id: 1, childNodes: [inputNode(9, { type: "password", value: "CLEAREDPW555" })] } },
    timestamp: 1,
  }];
  redactEvents(events, new Map());
  assert.doesNotMatch(JSON.stringify(events), /CLEAREDPW555/);
});

test("I1: a textarea's raw value is masked the same way as an input's", () => {
  const { redactEvents } = load();
  const events = [{ type: 2, data: { node: { type: 0, id: 1, childNodes: [{ type: 2, tagName: "textarea", attributes: { value: "SECRETNOTE" }, id: 5, childNodes: [] }] } }, timestamp: 1 }];
  redactEvents(events, new Map());
  assert.doesNotMatch(JSON.stringify(events), /SECRETNOTE/);
});

// Fix round 3, item 4 (pulled): an unmasked value (option/button) still kept
// a URL's query. The controller's ruling keeps these values (page content),
// but they still need the same URL scrub every other attribute gets.
test("I1/item 4: an option's URL-bearing value is scrubbed of its query, even though it isn't masked", () => {
  const { redactEvents } = load();
  const events = [{
    type: 2,
    data: { node: { type: 0, id: 1, childNodes: [{ type: 2, tagName: "option", attributes: { value: "https://x.test/cb?token=OPTVAL1" }, id: 2, childNodes: [] }] } },
  }];
  redactEvents(events, new Map());
  const value = events[0].data.node.childNodes[0].attributes.value;
  assert.doesNotMatch(value, /OPTVAL1/);
  assert.doesNotMatch(value, /^\*+$/, "an option's value is page content — scrubbed, not asterisk-masked");
});

test("I1/item 4: a button's URL-bearing value is scrubbed of its query", () => {
  const { redactEvents } = load();
  const events = [{
    type: 2,
    data: { node: { type: 0, id: 1, childNodes: [{ type: 2, tagName: "button", attributes: { value: "https://x.test/go?token=BTNVAL1" }, id: 2, childNodes: [] }] } },
  }];
  redactEvents(events, new Map());
  assert.doesNotMatch(events[0].data.node.childNodes[0].attributes.value, /BTNVAL1/);
});

test("I1/item 4: an option value mutation on a known option id is scrubbed of its query", () => {
  const { redactEvents } = load();
  const knownTags = new Map([[11, "option"]]);
  const events = [{ type: 3, data: { source: 0, texts: [], removes: [], adds: [], attributes: [{ id: 11, attributes: { value: "https://x.test/cb?token=OPTMUT1" } }] } }];
  redactEvents(events, knownTags);
  assert.doesNotMatch(events[0].data.attributes[0].attributes.value, /OPTMUT1/);
});

// Fix round 3, item 4 (pulled): rrweb sends a style change as a diff object
// (property -> new value) when the diff is shorter than the whole style
// string — a framework-style el.style.backgroundImage = "url(...)" takes this
// path, and a signed image URL's query rode along unscrubbed.
test("I1/item 4: a style attribute mutation's diff object has its string properties scrubbed", () => {
  const { redactEvents } = load();
  const events = [{ type: 3, data: { source: 0, texts: [], removes: [], adds: [], attributes: [{ id: 6, attributes: { style: { "background-image": 'url("https://x.test/i.png?token=STYMUT2")' } } }] } }];
  redactEvents(events, new Map());
  assert.doesNotMatch(JSON.stringify(events), /STYMUT2/);
});

// Fix round 4, item 2: a style attribute is a string in a snapshot, and also
// in a mutation whose diff would be longer than the whole value (the usual
// case for el.style.x = ... on an element without an inline style). A diff
// value is a string, a [value, priority] array for setProperty(...,
// "important"), or false for a removed property. The shapes and markers are
// the ones real rrweb sent in the round 3 re-review.
test("redactEvents: an inline style string in a full snapshot is scrubbed", () => {
  const { redactEvents } = load();
  const events = [{ type: 2, data: { node: { type: 0, id: 1, childNodes: [{ type: 2, tagName: "div", attributes: { style: "background-image: url(https://x.test/i.png?token=STYSNAP1)" }, id: 2, childNodes: [] }] } } }];
  redactEvents(events, new Map());
  const style = events[0].data.node.childNodes[0].attributes.style;
  assert.doesNotMatch(style, /STYSNAP1/);
  assert.match(style, /^background-image: url\(https:\/\/x\.test\/i\.png\?…/);
});

test("redactEvents: a style mutation sent as a whole string is scrubbed", () => {
  const { redactEvents } = load();
  const events = [{ type: 3, data: { source: 0, texts: [], removes: [], adds: [], attributes: [{ id: 2, attributes: { style: 'background-image: url("https://x.test/i.png?token=STYMUT1");' } }] } }];
  redactEvents(events, new Map());
  assert.equal(events[0].data.attributes[0].attributes.style, 'background-image: url("https://x.test/i.png?…");');
});

test("redactEvents: an !important style diff ([value, priority]) is scrubbed, keeping its priority and removed properties", () => {
  const { redactEvents } = load();
  const events = [{ type: 3, data: { source: 0, texts: [], removes: [], adds: [], attributes: [{ id: 6, attributes: { style: { "background-image": ['url("https://x.test/i.png?token=STYIMP1")', "important"], color: false } } }] } }];
  redactEvents(events, new Map());
  assert.deepEqual(events[0].data.attributes[0].attributes.style, { "background-image": ['url("https://x.test/i.png?…")', "important"], color: false });
});

// Fix round 4, item 1: the quote-in-query regression as the walker meets it,
// on a data-* attribute in a snapshot and in a later setAttribute mutation.
test("redactEvents: a URL with a ' in its query is scrubbed from a data-x attribute in a snapshot and in a mutation", () => {
  const { redactEvents } = load();
  const knownTags = new Map();
  const snapshot = [{ type: 2, data: { node: { type: 0, id: 1, childNodes: [{ type: 2, tagName: "div", attributes: { id: "apos", "data-x": "https://x.test/s?q=it's&token=APOSSNAP1" }, id: 12, childNodes: [] }] } } }];
  const mutation = [{ type: 3, data: { source: 0, texts: [], removes: [], adds: [], attributes: [{ id: 12, attributes: { "data-x": "https://x.test/s?q=it's&token=APOSMUT1" } }] } }];
  redactEvents(snapshot, knownTags);
  redactEvents(mutation, knownTags);
  assert.equal(snapshot[0].data.node.childNodes[0].attributes["data-x"], "https://x.test/s?…");
  assert.equal(mutation[0].data.attributes[0].attributes["data-x"], "https://x.test/s?…");
});

test("I1: an option's value is left alone, since it is page content, not a typed secret", () => {
  const { redactEvents } = load();
  const events = [{
    type: 2,
    data: { node: { type: 0, id: 1, childNodes: [{ type: 2, tagName: "select", attributes: {}, id: 10, childNodes: [{ type: 2, tagName: "option", attributes: { value: "US" }, id: 11, childNodes: [] }] }] } },
    timestamp: 1,
  }];
  redactEvents(events, new Map());
  assert.equal(events[0].data.node.childNodes[0].childNodes[0].attributes.value, "US");
});

test("I1: a late-added hidden input (a mutation's adds entry) is masked", () => {
  const { redactEvents } = load();
  const events = [{ type: 3, data: { source: 0, texts: [], removes: [], attributes: [], adds: [{ parentId: 7, nextId: null, node: inputNode(14, { type: "hidden", value: "LATEHIDDEN1414" }) }] }, timestamp: 1 }];
  redactEvents(events, new Map());
  assert.doesNotMatch(JSON.stringify(events), /LATEHIDDEN1414/);
});

test("I1: an attribute mutation's value is masked when the target id was already known to be an input", () => {
  const { redactEvents } = load();
  const knownTags = new Map([[9, "input"]]);
  const events = [{ type: 3, data: { source: 0, texts: [], removes: [], adds: [], attributes: [{ id: 9, attributes: { value: "CLEAREDPW555" } }] } }];
  redactEvents(events, knownTags);
  assert.doesNotMatch(JSON.stringify(events), /CLEAREDPW555/);
});

test("I1: an attribute mutation's value is left alone when the target id is a known option", () => {
  const { redactEvents } = load();
  const knownTags = new Map([[11, "option"]]);
  const events = [{ type: 3, data: { source: 0, texts: [], removes: [], adds: [], attributes: [{ id: 11, attributes: { value: "CA" } }] } }];
  redactEvents(events, knownTags);
  assert.equal(events[0].data.attributes[0].attributes.value, "CA");
});

// Fix round 2 (controller ruling, binding): an id the walker has never seen —
// after a worker restart (the tag map is only in memory) or any batch dropped
// before reaching the walker — must fail closed and be masked, accepting that
// a button's or meter's value gets masked too as a rare, acceptable cost.
test("I1 (controller ruling): a value mutation on a completely unknown node id is masked, not left raw", () => {
  const { redactEvents } = load();
  const events = [{ type: 3, data: { source: 0, texts: [], removes: [], adds: [], attributes: [{ id: 57, attributes: { value: "UNKNOWNIDPW1" } }] } }];
  redactEvents(events, new Map()); // empty map: id 57 has never been seen
  assert.doesNotMatch(JSON.stringify(events), /UNKNOWNIDPW1/);
});

test("I1 (controller ruling): a value mutation on an id known to be something other than input/textarea is still left alone", () => {
  const { redactEvents } = load();
  const knownTags = new Map([[9, "div"]]);
  const events = [{ type: 3, data: { source: 0, texts: [], removes: [], adds: [], attributes: [{ id: 9, attributes: { value: "PAGECONTENT" } }] } }];
  redactEvents(events, knownTags);
  assert.equal(events[0].data.attributes[0].attributes.value, "PAGECONTENT");
});

// Pulled in from the re-review: a URL can ride in as free text inside an
// attribute that isn't one of the dedicated URL attributes (e.g. a <meta
// property="og:url"> or any other content attribute).
test("I2 (pulled in): a URL embedded in a non-URL attribute's free text is scrubbed too", () => {
  const { redactEvents } = load();
  const events = [{
    type: 2,
    data: { node: { type: 0, id: 1, childNodes: [{ type: 2, tagName: "meta", attributes: { property: "og:url", content: "https://x.test/a?token=OGSECRET1" }, id: 2, childNodes: [] }] } },
  }];
  redactEvents(events, new Map());
  assert.doesNotMatch(JSON.stringify(events), /OGSECRET1/);
});

// A node's defining snapshot/add can land in an earlier batch than a later
// attribute mutation on it (rrweb flushes on its own 1s/100-event schedule) —
// the caller must be able to reuse the same knownTags Map across two separate
// redactEvents calls and still have the second one recognize the id.
test("I1: knownTags persists across two calls, so a later batch's mutation on an earlier batch's input is still masked", () => {
  const { redactEvents } = load();
  const knownTags = new Map();
  const batch1 = [{ type: 2, data: { node: { type: 0, id: 1, childNodes: [inputNode(9, { type: "password", value: "" })] } } }];
  redactEvents(batch1, knownTags);
  assert.equal(knownTags.get(9), "input");

  const batch2 = [{ type: 3, data: { source: 0, texts: [], removes: [], adds: [], attributes: [{ id: 9, attributes: { value: "TYPEDLATER99" } }] } }];
  redactEvents(batch2, knownTags);
  assert.doesNotMatch(JSON.stringify(batch2), /TYPEDLATER99/);
});

// A full snapshot means a fresh document (a navigation): rrweb's node ids
// restart from 1 there, so a stale id->tagName mapping from the previous
// document is not just useless but actively wrong (id 9 could now be a <div>).
test("I1: a new full snapshot resets knownTags, so a stale id from a previous document is not treated as an input", () => {
  const { redactEvents } = load();
  const knownTags = new Map([[9, "input"]]);
  const freshSnapshot = [{ type: 2, data: { node: { type: 0, id: 1, childNodes: [{ type: 2, tagName: "select", attributes: {}, id: 10, childNodes: [{ type: 2, tagName: "option", attributes: { value: "US" }, id: 9, childNodes: [] }] }] } } }];
  redactEvents(freshSnapshot, knownTags);
  assert.equal(knownTags.get(9), "option");
});

// Item 10: a Meta event (type 4) always starts a fresh document, the same
// document its own FullSnapshot is about to describe — reset knownTags there
// too, so a mutation that reaches the walker before that FullSnapshot's own
// arrival can never be read against a stale, wrong mapping left over from the
// previous document.
test("I1/item 10: a Meta event resets knownTags before its own FullSnapshot arrives, so a reused node id is never read from a stale mapping", () => {
  const { redactEvents } = load();
  const knownTags = new Map([[9, "div"]]); // previous document: id 9 was a <div>, not maskable
  const events = [
    { type: 4, data: { href: "https://x.test/" } }, // the new document begins
    { type: 3, data: { source: 0, texts: [], removes: [], adds: [], attributes: [{ id: 9, attributes: { value: "REUSEDID9SECRET" } }] } },
  ];
  redactEvents(events, knownTags);
  assert.doesNotMatch(JSON.stringify(events), /REUSEDID9SECRET/);
});

// --- redactEvents (I2): Meta href, and href/src/action/formaction/poster/srcset
// attributes in snapshots and mutations, all through redactUrl. ---

test("I2: a Meta event's href is redacted of its query and fragment", () => {
  const { redactEvents } = load();
  const events = [{ type: 4, data: { href: "http://127.0.0.1:9/a?token=SECRETQ#access_token=SECRETF", width: 1200, height: 800 }, timestamp: 1 }];
  redactEvents(events, new Map());
  assert.doesNotMatch(JSON.stringify(events), /SECRETQ|SECRETF/);
  assert.equal(events[0].data.href, "http://127.0.0.1:9/a?…#…");
});

test("I2: href/src/action/formaction/poster attributes are redacted in a full snapshot", () => {
  const { redactEvents } = load();
  const events = [{
    type: 2,
    data: {
      node: {
        type: 0, id: 1, childNodes: [
          { type: 2, tagName: "a", attributes: { href: "https://x.test/reset?token=abc" }, id: 2, childNodes: [] },
          { type: 2, tagName: "form", attributes: { action: "https://x.test/submit?token=abc" }, id: 3, childNodes: [] },
          { type: 2, tagName: "button", attributes: { formaction: "https://x.test/go?token=abc" }, id: 4, childNodes: [] },
          { type: 2, tagName: "video", attributes: { poster: "https://x.test/poster.jpg?token=abc" }, id: 5, childNodes: [] },
        ],
      },
    },
    timestamp: 1,
  }];
  redactEvents(events, new Map());
  const json = JSON.stringify(events);
  assert.doesNotMatch(json, /token=abc/);
  const [a, form, button, video] = events[0].data.node.childNodes;
  assert.equal(a.attributes.href, "https://x.test/reset?…");
  assert.equal(form.attributes.action, "https://x.test/submit?…");
  assert.equal(button.attributes.formaction, "https://x.test/go?…");
  assert.equal(video.attributes.poster, "https://x.test/poster.jpg?…");
});

test("I2: each URL inside a srcset is redacted, keeping the width/density descriptors", () => {
  const { redactEvents } = load();
  const events = [{ type: 2, data: { node: { type: 0, id: 1, childNodes: [{ type: 2, tagName: "img", attributes: { srcset: "https://x.test/a.png?tok=1 1x, https://x.test/b.png?tok=2 2x" }, id: 2, childNodes: [] }] } }, timestamp: 1 }];
  redactEvents(events, new Map());
  const srcset = events[0].data.node.childNodes[0].attributes.srcset;
  assert.doesNotMatch(srcset, /tok=/);
  assert.equal(srcset, "https://x.test/a.png?… 1x, https://x.test/b.png?… 2x");
});

test("redactEvents returns the same array it was given, for convenient chaining", () => {
  const { redactEvents } = load();
  const events = [{ type: 4, data: { href: "https://x.test/" } }];
  assert.equal(redactEvents(events, new Map()), events);
});

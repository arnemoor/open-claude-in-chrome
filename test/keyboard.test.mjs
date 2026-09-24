import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadBackground } from "./harness/fake-chrome.mjs";
import { chromeAvailable, launchChrome, openPage } from "./harness/browser.mjs";

const FORM = `<form id=f><input id=i autofocus><button id=b type=button>b</button></form>
<script>
  window.ev = []; window.submits = 0; window.clicks = 0;
  for (const t of ["keydown", "keyup"]) document.addEventListener(t, (e) => ev.push([t, e.key, e.code, e.keyCode, e.shiftKey]), true);
  document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); submits++; });
  document.getElementById("b").addEventListener("click", () => clicks++);
</script>`;

let browser;
before(async () => { if (chromeAvailable) browser = await launchChrome(); }, { timeout: 20000 });
after(() => browser?.close());

async function setup() {
  const page = await openPage(browser, { html: FORM });
  await page.evaluate("document.getElementById('i').focus()");
  const bg = await loadBackground({ page });
  const run = (a) => bg.handlers.computer({ tabId: bg.tabId, ...a });
  return { page, run };
}

test("type sends real key events and lands exactly", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { page, run } = await setup();
  await run({ action: "type", text: "hi!" });
  assert.equal(await page.evaluate("i.value"), "hi!");
  const ev = await page.evaluate("ev");
  assert.deepEqual(ev.filter((e) => e[0] === "keydown").map((e) => e.slice(1)), [["h", "KeyH", 72, false], ["i", "KeyI", 73, false], ["!", "Digit1", 49, true]]);
});

test("type handles umlauts, emoji and CJK, and \\n never submits", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { page, run } = await setup();
  const reply = await run({ action: "type", text: "Grüße 😀 日本\nx" });
  assert.equal(await page.evaluate("i.value"), "Grüße 😀 日本x");
  assert.equal(await page.evaluate("submits"), 0);
  assert.match(reply.content[0].text, /line breaks were not typed: the focused field is single-line/);
});

test("key Enter submits, letters type, Backspace deletes", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { page, run } = await setup();
  await run({ action: "key", text: "a shift+b Backspace a" });
  assert.equal(await page.evaluate("i.value"), "aa");
  await run({ action: "key", text: "Enter" });
  assert.equal(await page.evaluate("submits"), 1);
});

test("key space presses a focused button, Tab moves focus", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { page, run } = await setup();
  await run({ action: "key", text: "Tab" });
  assert.equal(await page.evaluate("document.activeElement.id"), "b");
  await run({ action: "key", text: "space" });
  assert.equal(await page.evaluate("clicks"), 1);
});

test("select-all shortcut selects and types nothing", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { page, run } = await setup();
  await run({ action: "type", text: "hello" });
  await run({ action: "key", text: process.platform === "darwin" ? "cmd+a" : "ctrl+a" });
  assert.deepEqual(await page.evaluate("[i.value, i.selectionStart, i.selectionEnd]"), ["hello", 0, 5]);
});

test("cmd+A (uppercase) selects on macOS like cmd+a", { skip: !chromeAvailable || process.platform !== "darwin", timeout: 20000 }, async () => {
  const { page, run } = await setup();
  await run({ action: "type", text: "hello" });
  await run({ action: "key", text: "cmd+A" });
  assert.deepEqual(await page.evaluate("[i.value, i.selectionStart, i.selectionEnd]"), ["hello", 0, 5]);
});

test("unknown key names are reported, not sent", async () => {
  const bg = await loadBackground();
  const r = await bg.handlers.computer({ action: "key", text: "Foo", tabId: bg.tabId });
  assert.equal(r.content[0].text, "Unknown key: Foo");
  assert.equal(bg.calls.filter((c) => c[1] === "Input.dispatchKeyEvent").length, 0);
});

test("Object.prototype names are reported as unknown keys, not sent", async () => {
  const bg = await loadBackground();
  for (const name of ["toString", "constructor", "__proto__", "valueOf"]) {
    const r = await bg.handlers.computer({ action: "key", text: name, tabId: bg.tabId });
    assert.equal(r.content[0].text, `Unknown key: ${name}`);
  }
  assert.equal(bg.calls.filter((c) => c[1] === "Input.dispatchKeyEvent").length, 0);
});

test("an unresolvable focus kind skips newlines and notes it could not be checked", async () => {
  // Record calls ourselves: overriding sendCommand replaces the harness's own recorder, so
  // bg.calls would only ever see debugger.attach and this assertion would pass vacuously.
  const sent = [];
  const bg = await loadBackground({ overrides: { debugger: { sendCommand: async (t, m, p) => {
    sent.push([m, p]);
    return m === "Runtime.evaluate" ? { result: { value: null } } : {};
  } } } });
  const r = await bg.handlers.computer({ action: "type", text: "a\nb", tabId: bg.tabId });
  assert.match(r.content[0].text, /line breaks were not typed: could not be checked/);
  assert.ok(sent.some(([m]) => m === "Runtime.evaluate"), "the focus probe should have run");
  assert.equal(sent.filter(([m, p]) => m === "Input.insertText" && p?.text === "\n").length, 0);
});

test("a hung focus probe falls back to unknown within its own timeout, not the 30s default", { timeout: 5000 }, async () => {
  const bg = await loadBackground({ overrides: { debugger: { sendCommand: async (t, m) => (m === "Runtime.evaluate" ? new Promise(() => {}) : {}) } } });
  const start = Date.now();
  const r = await bg.handlers.computer({ action: "type", text: "a\nb", tabId: bg.tabId });
  assert.ok(Date.now() - start < 2500, `took ${Date.now() - start}ms`);
  assert.match(r.content[0].text, /line breaks were not typed: could not be checked/);
});

// --- Multi-line fields: textarea and contenteditable, alongside a single-line input ---

const MULTI_PAGE = `<form id=f><input id=inp><textarea id=ta></textarea><div id=ce contenteditable=true></div></form>
<script>
  window.submits = 0;
  document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); submits++; });
</script>`;

const FOCUS_MULTI = {
  inp: "document.getElementById('inp').focus()",
  ta: "document.getElementById('ta').focus()",
  ce: "(() => { const ce = document.getElementById('ce'); ce.focus(); const r = document.createRange(); r.selectNodeContents(ce); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()",
};

async function setupMulti(target) {
  const page = await openPage(browser, { html: MULTI_PAGE });
  await page.evaluate(FOCUS_MULTI[target]);
  const bg = await loadBackground({ page });
  const run = (a) => bg.handlers.computer({ tabId: bg.tabId, ...a });
  return { page, run };
}

test("type lands newlines exactly in a textarea, normalizing CRLF", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { page, run } = await setupMulti("ta");
  await run({ action: "type", text: "l1\nl2\r\nl3" });
  assert.equal(await page.evaluate("ta.value"), "l1\nl2\nl3");
  assert.equal(await page.evaluate("submits"), 0);
});

test("type lands a tab character in a textarea", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { page, run } = await setupMulti("ta");
  await run({ action: "type", text: "a\tb" });
  assert.equal(await page.evaluate("ta.value"), "a\tb");
});

test("type lands newlines in a contenteditable", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { page, run } = await setupMulti("ce");
  await run({ action: "type", text: "l1\nl2" });
  const text = await page.evaluate("ce.innerText");
  assert.equal(text, "l1\nl2");
});

test("type on a single-line input never submits and the reply notes dropped line breaks", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { page, run } = await setupMulti("inp");
  const reply = await run({ action: "type", text: "l1\nl2" });
  assert.equal(await page.evaluate("inp.value"), "l1l2");
  assert.equal(await page.evaluate("submits"), 0);
  assert.match(reply.content[0].text, /line breaks were not typed: the focused field is single-line/);
});

test("an input nested inside a contenteditable host is still single-line", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const page = await openPage(browser, { html: `<form id=f><div contenteditable>x<input id=x>y</div></form>
<script>
  window.submits = 0;
  document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); submits++; });
</script>` });
  await page.evaluate("document.getElementById('x').focus()");
  const bg = await loadBackground({ page });
  const run = (a) => bg.handlers.computer({ tabId: bg.tabId, ...a });
  const reply = await run({ action: "type", text: "a\nb" });
  assert.equal(await page.evaluate("x.value"), "ab");
  assert.equal(await page.evaluate("submits"), 0);
  assert.match(reply.content[0].text, /line breaks were not typed: the focused field is single-line/);
});

test("a focus change mid-type is picked up before the next newline", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const page = await openPage(browser, { html: `<form id=f><textarea id=ta></textarea><input id=inp></form>
<script>
  window.submits = 0;
  document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); submits++; });
  document.getElementById("ta").addEventListener("input", () => document.getElementById("inp").focus(), { once: true });
</script>` });
  await page.evaluate("document.getElementById('ta').focus()");
  const bg = await loadBackground({ page });
  const run = (a) => bg.handlers.computer({ tabId: bg.tabId, ...a });
  const reply = await run({ action: "type", text: "a\nb" });
  assert.equal(await page.evaluate("ta.value"), "a");
  assert.equal(await page.evaluate("inp.value"), "b");
  assert.equal(await page.evaluate("submits"), 0);
  assert.match(reply.content[0].text, /line breaks were not typed: the focused field is single-line/);
});

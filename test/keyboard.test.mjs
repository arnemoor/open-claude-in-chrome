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
before(async () => { if (chromeAvailable) browser = await launchChrome(); });
after(() => browser?.close());

async function setup() {
  const page = await openPage(browser, { html: FORM });
  await page.evaluate("document.getElementById('i').focus()");
  const bg = await loadBackground({ page });
  const run = (a) => bg.handlers.computer({ tabId: bg.tabId, ...a });
  return { page, run };
}

test("type sends real key events and lands exactly", { skip: !chromeAvailable }, async () => {
  const { page, run } = await setup();
  await run({ action: "type", text: "hi!" });
  assert.equal(await page.evaluate("i.value"), "hi!");
  const ev = await page.evaluate("ev");
  assert.deepEqual(ev.filter((e) => e[0] === "keydown").map((e) => e.slice(1)), [["h", "KeyH", 72, false], ["i", "KeyI", 73, false], ["!", "Digit1", 49, true]]);
});

test("type handles umlauts, emoji and CJK, and \\n never submits", { skip: !chromeAvailable }, async () => {
  const { page, run } = await setup();
  await run({ action: "type", text: "Grüße 😀 日本\nx" });
  assert.equal(await page.evaluate("i.value"), "Grüße 😀 日本x");
  assert.equal(await page.evaluate("submits"), 0);
});

test("key Enter submits, letters type, Backspace deletes", { skip: !chromeAvailable }, async () => {
  const { page, run } = await setup();
  await run({ action: "key", text: "a shift+b Backspace a" });
  assert.equal(await page.evaluate("i.value"), "aa");
  await run({ action: "key", text: "Enter" });
  assert.equal(await page.evaluate("submits"), 1);
});

test("key space presses a focused button, Tab moves focus", { skip: !chromeAvailable }, async () => {
  const { page, run } = await setup();
  await run({ action: "key", text: "Tab" });
  assert.equal(await page.evaluate("document.activeElement.id"), "b");
  await run({ action: "key", text: "space" });
  assert.equal(await page.evaluate("clicks"), 1);
});

test("select-all shortcut selects and types nothing", { skip: !chromeAvailable }, async () => {
  const { page, run } = await setup();
  await run({ action: "type", text: "hello" });
  await run({ action: "key", text: process.platform === "darwin" ? "cmd+a" : "ctrl+a" });
  assert.deepEqual(await page.evaluate("[i.value, i.selectionStart, i.selectionEnd]"), ["hello", 0, 5]);
});

test("unknown key names are reported, not sent", async () => {
  const bg = await loadBackground();
  const r = await bg.handlers.computer({ action: "key", text: "Foo", tabId: bg.tabId });
  assert.equal(r.content[0].text, "Unknown key: Foo");
  assert.equal(bg.calls.filter((c) => c[1] === "Input.dispatchKeyEvent").length, 0);
});

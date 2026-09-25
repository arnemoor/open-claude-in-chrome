// Minor 4: while a JS dialog (alert/confirm/prompt/beforeunload) blocks a tab, CDP calls against
// it either silently no-op (type reported success with nothing typed) or hang until dismissed
// (screenshot waited the full 30s). tabAccessError now refuses those tools up front instead, and
// a content-script message that never answers for any other reason times out with a clear error
// instead of hanging forever.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadBackground } from "./harness/fake-chrome.mjs";
import { chromeAvailable, launchChrome, openPage } from "./harness/browser.mjs";

test("a content script that never responds times out instead of hanging the call", { timeout: 5000 }, async () => {
  const bg = await loadBackground({ overrides: { tabs: { sendMessage: () => new Promise(() => {}) } } });
  const start = Date.now();
  await assert.rejects(bg.get("sendContentMessage")(bg.tabId, { type: "getPageText" }, 50), /did not respond within 0\.05s/);
  assert.ok(Date.now() - start < 2000, `expected a fast timeout, took ${Date.now() - start}ms`);
});

test("a content script that answers before the timeout still works", async () => {
  const bg = await loadBackground({ overrides: { tabs: { sendMessage: async () => ({ result: "ok" }) } } });
  const result = await bg.get("sendContentMessage")(bg.tabId, { type: "getPageText" }, 50);
  assert.deepEqual({ ...result }, { result: "ok" });
});

let browser;
before(async () => { if (chromeAvailable) browser = await launchChrome(); }, { timeout: 30000 });
after(() => browser?.close());

test("real Chrome: an open JS dialog refuses type and screenshot instead of a false success or a long wait", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const page = await openPage(browser, { html: `<input id="i">` });
  const bg = await loadBackground({ page });

  // Attach and enable the Page domain before the dialog opens, the same way any earlier tool
  // call in a real session would have.
  await bg.handlers.computer({ action: "screenshot", tabId: bg.tabId });

  page.send("Runtime.evaluate", { expression: "alert('hold on')" }); // fire-and-forget: this CDP call itself won't resolve until the dialog closes
  await new Promise((resolve) => {
    const off = page.browser.onEvent((m) => {
      if (m.sessionId === page.sessionId && m.method === "Page.javascriptDialogOpening") { off(); resolve(); }
    });
  });

  const expectedText = `A JavaScript dialog is open on this tab ("hold on"). It blocks the page until the user closes it.`;

  const typeStart = Date.now();
  const typed = await bg.handlers.computer({ action: "type", text: "hi", tabId: bg.tabId });
  assert.equal(typed.content[0].text, expectedText);
  assert.ok(Date.now() - typeStart < 2000, `type should refuse quickly, took ${Date.now() - typeStart}ms`);

  const shotStart = Date.now();
  const shot = await bg.handlers.computer({ action: "screenshot", tabId: bg.tabId });
  assert.equal(shot.content.length, 1, "no image block on a refusal");
  assert.equal(shot.content[0].text, expectedText);
  assert.ok(Date.now() - shotStart < 2000, `screenshot should refuse quickly, took ${Date.now() - shotStart}ms`);

  await page.send("Page.handleJavaScriptDialog", { accept: true });
  // Confirm the field really is still empty — the false-success failure mode this guards
  // against reported "Typed" while leaving the field untouched.
  assert.equal(await page.evaluate("document.getElementById('i').value"), "");
});

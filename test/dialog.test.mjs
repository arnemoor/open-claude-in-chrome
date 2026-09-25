// Minor 4: while a JS dialog (alert/confirm/prompt/beforeunload) blocks a tab, CDP calls against
// it either silently no-op (type reported success with nothing typed) or hang until dismissed
// (screenshot waited the full 30s). tabAccessError now refuses those tools up front instead, and
// a content-script message that never answers for any other reason times out with a clear error
// instead of hanging forever.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadBackground } from "./harness/fake-chrome.mjs";
import { chromeAvailable, launchChrome, openPage, evaluate, injectContentScript } from "./harness/browser.mjs";

const CONTENT = path.join(import.meta.dirname, "..", "extension", "content.js");

test("a content script that never responds times out instead of hanging the call", { timeout: 5000 }, async () => {
  const bg = await loadBackground({ overrides: { tabs: { sendMessage: () => new Promise(() => {}) } } });
  const start = Date.now();
  await assert.rejects(
    bg.get("sendContentMessage")(bg.tabId, { type: "getPageText" }, 50),
    (err) => err.message === "The page did not respond within 0.05 s (it may be busy or showing a dialog). The action may still complete.",
  );
  assert.ok(Date.now() - start < 2000, `expected a fast timeout, took ${Date.now() - start}ms`);
});

test("a content script that answers before the timeout still works", async () => {
  const bg = await loadBackground({ overrides: { tabs: { sendMessage: async () => ({ result: "ok" }) } } });
  const result = await bg.get("sendContentMessage")(bg.tabId, { type: "getPageText" }, 50);
  assert.deepEqual({ ...result }, { result: "ok" });
});

// Round 2 item 2: a dialog that opens while a CDP call is already in flight (probe E: a click
// whose onclick handler calls confirm()) left that call to run out its own 30s timeout, since a
// dialog freezes every CDP command against the renderer regardless of when it was issued.
// Rejecting the moment the dialog opens turns that into an immediate, clear failure.
test("a dialog opening mid-call rejects a pending CDP command immediately, not after its own timeout", { timeout: 5000 }, async () => {
  const bg = await loadBackground({ overrides: { debugger: { sendCommand: async (t, m) => (m === "Input.dispatchMouseEvent" ? new Promise(() => {}) : {}) } } });
  const rawCdp = bg.get("rawCdp");
  const pending = rawCdp(bg.tabId, "Input.dispatchMouseEvent", {});
  await new Promise((r) => setTimeout(r, 20)); // let it actually become pending first
  const start = Date.now();
  bg.chrome.debugger.onEvent.fire({ tabId: bg.tabId }, "Page.javascriptDialogOpening", { message: "confirm?" });
  await assert.rejects(pending, (err) => err.dialogMessage === "confirm?");
  assert.ok(Date.now() - start < 1000, `expected an immediate rejection, took ${Date.now() - start}ms`);
});

// For a click specifically, the click itself already happened before the dialog interrupted the
// rest of the dispatch, so the reply says so instead of surfacing the raw internal error.
test("a click that triggers a dialog mid-dispatch reports it, instead of a raw error", async () => {
  let bg;
  const sendCommand = async (t, m, p) => {
    if (m === "Input.dispatchMouseEvent" && p.type === "mousePressed") {
      bg.chrome.debugger.onEvent.fire({ tabId: bg.tabId }, "Page.javascriptDialogOpening", { message: "confirm?" });
      return new Promise(() => {}); // never resolves: a dialog now blocks the response
    }
    return {};
  };
  bg = await loadBackground({ overrides: { debugger: { sendCommand } } });
  const r = await bg.handlers.computer({ action: "left_click", coordinate: [10, 10], tabId: bg.tabId });
  assert.equal(r.content[0].text, `Clicked, and the page opened a JavaScript dialog ("confirm?"). It blocks the page until the user closes it.`);
});

// Round 2 item 3: the dialog refusal was broader than the brief ("tools that need the page") —
// it also blocked tabs_close_mcp, navigate and resize_window, so only the user could ever free a
// dialog-locked tab. Closing or navigating a tab dismisses its dialog, and resize_window never
// touches the page's own JS thread (window.get/update are browser-level, and readViewport
// already degrades to null within its own short budget instead of hanging — confirmed with a
// live probe: a dialog left windows.update instant and readViewport back in ~1s, not 30s).
function simulateDialog(bg, message = "hi") {
  bg.chrome.debugger.onEvent.fire({ tabId: bg.tabId }, "Page.javascriptDialogOpening", { message });
}

test("a dialog still blocks a tool that needs the page", async () => {
  const bg = await loadBackground();
  simulateDialog(bg);
  const r = await bg.handlers.get_page_text({ tabId: bg.tabId });
  assert.equal(r.content[0].text, `A JavaScript dialog is open on this tab ("hi"). It blocks the page until the user closes it.`);
});

test("a dialog does not block tabs_close_mcp", async () => {
  const bg = await loadBackground();
  simulateDialog(bg);
  const r = await bg.handlers.tabs_close_mcp({ tabId: bg.tabId });
  assert.equal(r.content[0].text, `Closed tab ${bg.tabId}.`);
});

test("a dialog does not block navigate", async () => {
  let bg;
  const update = async () => { setTimeout(() => bg.chrome.tabs.onUpdated.fire(bg.tabId, { status: "complete" }), 0); };
  bg = await loadBackground({ overrides: { tabs: { update } } });
  simulateDialog(bg);
  const r = await bg.handlers.navigate({ url: "https://example.com", tabId: bg.tabId });
  assert.match(r.content[0].text, /^Navigated to/);
});

test("a dialog does not block resize_window", async () => {
  const bg = await loadBackground();
  simulateDialog(bg);
  const r = await bg.handlers.resize_window({ width: 900, height: 600, tabId: bg.tabId });
  assert.match(r.content[0].text, /^Resized window to/);
});

// Round 2 item 4: mutation check, independent of any real browser. Removing the Page.enable
// call from ensureAttached must turn this red on its own — it does not depend on the harness (or
// a real browser) enabling Page some other way, unlike a test that only checks a dialog gets
// tracked (which real Chrome's own openPage() helper would mask, since it always Page.enables).
test("ensureAttached enables the Page domain", async () => {
  const bg = await loadBackground();
  await bg.get("ensureAttached")(bg.tabId);
  assert.ok(bg.calls.some((c) => c[0] === "cdp" && c[1] === "Page.enable"), `expected a Page.enable CDP call, got: ${JSON.stringify(bg.calls)}`);
});

// Round 2 item 1: a dialog that opens before the tab is ever attached was never seen (probe F:
// tabs_create_mcp, then navigate, then the page alerts on load — every CDP call then waits the
// full 30s until the user closes it). navigate and tabs_create_mcp now attach (enabling Page)
// before they touch the tab, not after.
test("navigate attaches before it updates the tab, not after", async () => {
  let bg;
  // Mirrors the default mock's own calls.push (lost by overriding tabs.update outright), so the
  // call-order check below can actually see it.
  const update = async (...a) => { bg.calls.push(["tabs.update", ...a]); setTimeout(() => bg.chrome.tabs.onUpdated.fire(bg.tabId, { status: "complete" }), 0); };
  bg = await loadBackground({ overrides: { tabs: { update } } });
  await bg.handlers.navigate({ url: "https://example.com", tabId: bg.tabId });
  const attachIdx = bg.calls.findIndex((c) => c[0] === "cdp" && c[1] === "Page.enable");
  const updateIdx = bg.calls.findIndex((c) => c[0] === "tabs.update");
  assert.ok(attachIdx !== -1, "expected a Page.enable call");
  assert.ok(updateIdx !== -1, "expected a tabs.update call");
  assert.ok(attachIdx < updateIdx, `expected Page.enable before tabs.update, got order: ${bg.calls.map((c) => c[0] + (c[1] ? ":" + c[1] : "")).join(", ")}`);
});

test("tabs_create_mcp attaches the tab it just created", async () => {
  const bg = await loadBackground();
  await bg.handlers.tabs_create_mcp({});
  assert.ok(bg.calls.some((c) => c[0] === "cdp" && c[1] === "Page.enable"), `expected a Page.enable CDP call, got: ${JSON.stringify(bg.calls)}`);
});

// A failed attach must not break navigate/tabs_create_mcp's ordinary function: some pages (e.g.
// chrome://) refuse debugger attach outright, and these tools worked fine on them before this
// fix (never attaching at all).
test("navigate still works when the pre-navigate attach fails", async () => {
  let bg;
  const update = async () => { setTimeout(() => bg.chrome.tabs.onUpdated.fire(bg.tabId, { status: "complete" }), 0); };
  bg = await loadBackground({ overrides: { tabs: { update }, debugger: { attach: async () => { throw new Error("Cannot attach to this target."); } } } });
  const r = await bg.handlers.navigate({ url: "https://example.com", tabId: bg.tabId });
  assert.match(r.content[0].text, /^Navigated to/);
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

  page.send("Runtime.evaluate", { expression: "alert('hold on')" }).catch(() => {}); // fire-and-forget: this CDP call itself won't resolve until the dialog closes, and its eventual response (once dismissed, possibly after browser.close()) must not become an unhandled rejection
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

// Round 2 item 2, probe E: a click whose own onclick handler opens a dialog used to wait the
// full 30s for Input.dispatchMouseEvent, since the dialog freezes the renderer before CDP can
// answer that command at all.
test("real Chrome: a click that opens a dialog reports it quickly, not a 30s wait", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const page = await openPage(browser, { html: `<button id="b" onclick="confirm('sure?')" style="position:absolute;top:0;left:0;width:100px;height:40px">Go</button>` });
  const bg = await loadBackground({ page });

  const start = Date.now();
  const r = await bg.handlers.computer({ action: "left_click", coordinate: [50, 20], tabId: bg.tabId });
  assert.equal(r.content[0].text, `Clicked, and the page opened a JavaScript dialog ("sure?"). It blocks the page until the user closes it.`);
  assert.ok(Date.now() - start < 3000, `expected a fast reply, took ${Date.now() - start}ms`);

  await page.send("Page.handleJavaScriptDialog", { accept: true });
});

// Round 2 item 4: the full lifecycle, in real Chrome, on top of openPage()'s own Page.enable
// (fine here — this test's target is the javascriptDialogClosed handler's own cleanup of
// openDialogs, which matters regardless of who enabled Page; removing that handler leaves the
// tab refused forever even after the dialog is gone, which is exactly what "works again" catches).
test("real Chrome: dialog lifecycle refuses while open and works again once it closes", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const page = await openPage(browser, { html: `<title>Lifecycle</title><p>x</p>` });
  const cs = await injectContentScript(page, CONTENT);
  const bg = await loadBackground({ page, content: cs });
  await bg.handlers.computer({ action: "screenshot", tabId: bg.tabId });

  page.send("Runtime.evaluate", { expression: "alert('lifecycle')" }).catch(() => {}); // fire-and-forget, see the 'hold on' test above
  await new Promise((resolve) => {
    const off = page.browser.onEvent((m) => {
      if (m.sessionId === page.sessionId && m.method === "Page.javascriptDialogOpening") { off(); resolve(); }
    });
  });

  const blocked = await bg.handlers.get_page_text({ tabId: bg.tabId });
  assert.match(blocked.content[0].text, /^A JavaScript dialog is open on this tab \("lifecycle"\)/);

  // Registered before the command that triggers it, not after: the closed event can otherwise
  // arrive (and be missed, with nothing left to ever fire it again) before a listener added only
  // once the handleJavaScriptDialog response itself comes back.
  const closed = new Promise((resolve) => {
    const off = page.browser.onEvent((m) => {
      if (m.sessionId === page.sessionId && m.method === "Page.javascriptDialogClosed") { off(); resolve(); }
    });
  });
  await page.send("Page.handleJavaScriptDialog", { accept: true });
  await closed;

  const after = await bg.handlers.get_page_text({ tabId: bg.tabId });
  assert.doesNotMatch(after.content[0].text, /A JavaScript dialog is open/);
  assert.match(after.content[0].text, /Title:/);
});

// Round 2 item 1, end to end: a target with nothing CDP-enabled yet, unlike every other test's
// openPage() (which always Page.enables up front and would mask whether OUR ensureAttached call
// is what makes this work). navigate's pre-attach means a dialog moments after it returns is
// still tracked promptly, not after a fresh 30s attach hang (probe F).
test("real Chrome: a dialog just after navigate is tracked promptly, not after a 30s attach hang", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => browser.send(method, params, sessionId);
  const page = { targetId, sessionId, send, browser, evaluate: (expr) => evaluate(send, expr) };

  let bg;
  const update = async () => { setTimeout(() => bg.chrome.tabs.onUpdated.fire(bg.tabId, { status: "complete" }), 0); };
  bg = await loadBackground({ page, overrides: { tabs: { update } } });

  await bg.handlers.navigate({ url: "https://example.com", tabId: bg.tabId });

  send("Runtime.evaluate", { expression: "alert('fresh')" }).catch(() => {}); // fire-and-forget, see the 'hold on' test above
  await new Promise((resolve) => {
    const off = page.browser.onEvent((m) => {
      if (m.sessionId === page.sessionId && m.method === "Page.javascriptDialogOpening") { off(); resolve(); }
    });
  });

  const start = Date.now();
  const shot = await bg.handlers.computer({ action: "screenshot", tabId: bg.tabId });
  assert.match(shot.content[0].text, /^A JavaScript dialog is open on this tab \("fresh"\)/);
  assert.ok(Date.now() - start < 3000, `expected the dialog to already be tracked, took ${Date.now() - start}ms`);

  await send("Page.handleJavaScriptDialog", { accept: true });
});

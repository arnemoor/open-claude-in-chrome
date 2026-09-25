// A tool reply that reports a refusal or a failure carries isError: true, so an MCP client and
// browser_batch can tell it from a success without reading its text. A success never carries it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadBackground } from "./harness/fake-chrome.mjs";
import { chromeAvailable, launchChrome, openPage, injectContentScript } from "./harness/browser.mjs";

const CONTENT = path.join(import.meta.dirname, "..", "extension", "content.js");

const TAB = { id: 11, windowId: 1, status: "complete", url: "https://example.test/" };

function contentReplying(replies) {
  return { invoke: async (msg) => replies[msg.type] ?? { result: [] } };
}

async function refusal(bg, call) {
  const r = await call(bg);
  assert.equal(r.isError, true, `expected isError on: ${JSON.stringify(r)}`);
  return r.content[0].text;
}

test("a tab outside the MCP group is refused with isError", async () => {
  const bg = await loadBackground({ overrides: { tabs: { get: async (id) => ({ ...TAB, id, groupId: 8 }) } } });
  assert.equal(await refusal(bg, (b) => b.handlers.get_page_text({ tabId: 99 })), "Tab 99 is not in the MCP group.");
});

test("a tab showing a local file is refused with isError", async () => {
  const bg = await loadBackground({ tab: { url: "file:///Users/x/secret.txt" } });
  assert.equal(
    await refusal(bg, (b) => b.handlers.computer({ action: "screenshot", tabId: b.tabId })),
    "Tab 11 shows a local file or this extension's own page, which the agent cannot use.",
  );
});

test("a tab behind an open JS dialog is refused with isError", async () => {
  const bg = await loadBackground();
  bg.chrome.debugger.onEvent.fire({ tabId: bg.tabId }, "Page.javascriptDialogOpening", { message: "hi" });
  assert.equal(
    await refusal(bg, (b) => b.handlers.get_page_text({ tabId: b.tabId })),
    `A JavaScript dialog is open on this tab ("hi"). It blocks the page until the user closes it.`,
  );
});

test("navigate reports a refused URL, a failed update and a back onto a local file with isError", async () => {
  let url = TAB.url;
  let bg;
  bg = await loadBackground({
    overrides: {
      tabs: {
        get: async (id) => ({ ...TAB, id, groupId: 7, url }),
        update: async () => { throw new Error("boom"); },
        goBack: async () => { url = "file:///Users/x/secret.txt"; setTimeout(() => bg.chrome.tabs.onUpdated.fire(11, { status: "complete" }, {}), 0); },
      },
    },
  });
  assert.equal(await refusal(bg, (b) => b.handlers.navigate({ url: "javascript:alert(1)", tabId: 11 })), "javascript: URLs are not allowed. Use javascript_tool to run code.");
  assert.equal(await refusal(bg, (b) => b.handlers.navigate({ url: "https://x.test/", tabId: 11 })), "Could not navigate to https://x.test/: boom.");
  assert.equal(await refusal(bg, (b) => b.handlers.navigate({ url: "back", tabId: 11 })), "Tab 11 shows a local file or this extension's own page, which the agent cannot use.");
});

test("computer reports a missing argument and an unknown action with isError", async () => {
  const bg = await loadBackground();
  assert.equal(await refusal(bg, (b) => b.handlers.computer({ action: "left_click", tabId: 11 })), "coordinate is required for left_click");
  assert.equal(await refusal(bg, (b) => b.handlers.computer({ action: "type", tabId: 11 })), "text is required for type action");
  assert.equal(await refusal(bg, (b) => b.handlers.computer({ action: "key", text: "ctrl+nosuchkey", tabId: 11 })), "Unknown key: ctrl+nosuchkey");
  assert.equal(await refusal(bg, (b) => b.handlers.computer({ action: "fly", tabId: 11 })), "Unknown computer action: fly");
});

test("a content-script error reply from form_input, find, read_page and get_page_text carries isError", async () => {
  const error = { result: { error: "Element ref_99 not found or was garbage collected." } };
  const bg = await loadBackground({ content: contentReplying({ setFormValue: error, findElements: error, generateAccessibilityTree: error, getPageText: error }) });
  assert.equal(await refusal(bg, (b) => b.handlers.form_input({ ref: "ref_99", value: "x", tabId: 11 })), "Error: Element ref_99 not found or was garbage collected.");
  assert.equal(await refusal(bg, (b) => b.handlers.find({ query: "x", tabId: 11 })), "Element ref_99 not found or was garbage collected.");
  assert.equal(await refusal(bg, (b) => b.handlers.read_page({ tabId: 11 })), "Element ref_99 not found or was garbage collected.");
  assert.equal(await refusal(bg, (b) => b.handlers.get_page_text({ tabId: 11 })), "Element ref_99 not found or was garbage collected.");
});

test("read_page and get_page_text report a missing result with isError", async () => {
  const bg = await loadBackground({ content: contentReplying({ generateAccessibilityTree: { result: null }, getPageText: { result: null } }) });
  assert.equal(await refusal(bg, (b) => b.handlers.read_page({ tabId: 11 })), "Error: Could not generate accessibility tree");
  assert.equal(await refusal(bg, (b) => b.handlers.get_page_text({ tabId: 11 })), "Error: Could not extract page text");
});

// An empty tree is read_page's empty list: a status answer, not a failure.
test("read_page on an empty tree is a success with a no-elements line and the viewport", async () => {
  const bg = await loadBackground({ content: contentReplying({ generateAccessibilityTree: { result: "" } }) });
  const all = await bg.handlers.read_page({ tabId: 11 });
  assert.equal("isError" in all, false, JSON.stringify(all));
  assert.equal(all.content[0].text, "No elements found.\n\nViewport: 1200x713");
  const interactive = await bg.handlers.read_page({ tabId: 11, filter: "interactive" });
  assert.equal("isError" in interactive, false);
  assert.equal(interactive.content[0].text, "No interactive elements found.\n\nViewport: 1200x713");
});

test("javascript_tool reports a thrown exception with isError", async () => {
  const bg = await loadBackground({
    overrides: { debugger: { sendCommand: async (t, m, p) => (m === "Runtime.evaluate" && p.expression === "boom()" ? { exceptionDetails: { text: "Uncaught ReferenceError: boom is not defined" } } : {}) } },
  });
  assert.equal(await refusal(bg, (b) => b.handlers.javascript_tool({ text: "boom()", tabId: 11 })), "Error: Uncaught ReferenceError: boom is not defined");
});

test("upload_image, file_upload, tabs_create_mcp and an empty browser_batch report failures with isError", async () => {
  const bg = await loadBackground();
  assert.match(await refusal(bg, (b) => b.handlers.upload_image({ imageId: "nope", ref: "ref_1", tabId: 11 })), /^Image "nope" not found/);
  assert.equal(await refusal(bg, (b) => b.handlers.file_upload({ paths: ["/tmp/a.txt"], tabId: 11 })), "file_upload requires a 'ref' to a file input.");
  assert.equal(await refusal(bg, (b) => b.handlers.browser_batch({ actions: [] })), "browser_batch requires a non-empty 'actions' array.");
  const empty = await loadBackground({ overrides: { tabs: { query: async () => [] } } });
  assert.equal(await refusal(empty, (b) => b.handlers.tabs_create_mcp({})), "Could not create or find the MCP tab group.");
});

// These tools exist for parity only and do nothing here, so their reply is a failure.
test("the stub tools reply with isError", async () => {
  const bg = await loadBackground();
  const calls = [
    ["gif_creator", { action: "start_recording", tabId: 11 }],
    ["shortcuts_list", { tabId: 11 }],
    ["shortcuts_execute", { tabId: 11, command: "summarize" }],
    ["switch_browser", {}],
    ["list_connected_browsers", {}],
    ["select_browser", { deviceId: "device-1" }],
  ];
  for (const [name, args] of calls) {
    const r = await bg.handlers[name](args);
    assert.equal(r.isError, true, `${name}: ${JSON.stringify(r)}`);
    assert.match(r.content[0].text, /not (yet )?(implemented|supported)/, name);
  }
});

test("a success carries no isError, and neither do status answers or a click that opened a dialog", async () => {
  let bg;
  const sendCommand = async (t, m, p) => {
    if (m === "Input.dispatchMouseEvent" && p.type === "mousePressed") {
      bg.chrome.debugger.onEvent.fire({ tabId: bg.tabId }, "Page.javascriptDialogOpening", { message: "confirm?" });
      return new Promise(() => {});
    }
    if (m === "Page.captureScreenshot") return { data: "AAAA" };
    if (m === "Runtime.evaluate") return { result: { value: [1200, 713] } };
    return {};
  };
  const probePoint = { result: { inViewport: true, viewport: "1200x713", hit: "button", notes: [] } };
  bg = await loadBackground({ content: contentReplying({ findElements: { result: [] }, probePoint }), overrides: { debugger: { sendCommand } } });
  const results = {
    screenshot: await bg.handlers.computer({ action: "screenshot", tabId: 11 }),
    tabs_context_mcp: await bg.handlers.tabs_context_mcp({}),
    find: await bg.handlers.find({ query: "nothing here", tabId: 11 }),
    read_console_messages: await bg.handlers.read_console_messages({ tabId: 11 }),
  };
  results.click = await bg.handlers.computer({ action: "left_click", coordinate: [10, 10], tabId: 11 });
  for (const [name, r] of Object.entries(results)) assert.equal("isError" in r, false, `${name}: ${JSON.stringify(r)}`);
  assert.match(results.find.content[0].text, /^No elements found matching/);
  assert.match(results.click.content[0].text, /^Clicked, and the page opened a JavaScript dialog/);
});

// --- browser_batch stops at the first failed action ---

test("a batch whose second action returns an error result does not run the third", async () => {
  const bg = await loadBackground({ content: contentReplying({ setFormValue: { result: { error: "Element ref_99 not found or was garbage collected." } } }) });
  const r = await bg.handlers.browser_batch({
    actions: [
      { name: "computer", input: { action: "screenshot", tabId: 11 } },
      { name: "form_input", input: { ref: "ref_99", value: "100", tabId: 11 } },
      { name: "computer", input: { action: "key", text: "Enter", tabId: 11 } },
    ],
  });
  assert.equal(r.isError, true);
  assert.equal(bg.calls.filter((c) => c[0] === "cdp" && c[1] === "Input.dispatchKeyEvent").length, 0, "the third action must not run");
  const texts = r.content.filter((c) => c.type === "text").map((c) => c.text);
  assert.ok(texts.includes("Error: Element ref_99 not found or was garbage collected."), texts.join("\n"));
  assert.ok(!texts.some((t) => t.includes("Action 3/3")), texts.join("\n"));
  assert.equal(texts[texts.length - 1], "Action 2 (form_input) failed, so the batch stopped.");
});

test("a batch stops with isError on an action that throws, a nested batch or an unknown tool", async () => {
  const bg = await loadBackground(); // no content script: form_input's message and its retry both throw
  const thrown = await bg.handlers.browser_batch({ actions: [{ name: "form_input", input: { ref: "ref_1", value: "x", tabId: 11 } }, { name: "computer", input: { action: "key", text: "Enter", tabId: 11 } }] });
  assert.equal(thrown.isError, true);
  assert.match(thrown.content[thrown.content.length - 1].text, /^Action 1 \(form_input\) failed: /);
  assert.equal(bg.calls.filter((c) => c[0] === "cdp" && c[1] === "Input.dispatchKeyEvent").length, 0);

  const nested = await bg.handlers.browser_batch({ actions: [{ name: "browser_batch", input: { actions: [] } }] });
  assert.equal(nested.isError, true);
  assert.equal(nested.content[nested.content.length - 1].text, "Action 1: nested browser_batch is not allowed.");

  const unknown = await bg.handlers.browser_batch({ actions: [{ name: "no_such_tool", input: {} }] });
  assert.equal(unknown.isError, true);
  assert.equal(unknown.content[unknown.content.length - 1].text, 'Action 1: unknown tool "no_such_tool".');
});

let browser;
before(async () => {
  if (!chromeAvailable) return;
  browser = await launchChrome();
  await browser.send("Browser.setDownloadBehavior", { behavior: "deny" });
}, { timeout: 30000 });
after(async () => { await browser?.close(); });

test("real Chrome: read_page on about:blank and on a text-only page with filter interactive is a success", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const blank = await openPage(browser);
  const blankBg = await loadBackground({ page: blank, content: await injectContentScript(blank, CONTENT) });
  const r1 = await blankBg.handlers.read_page({ tabId: blankBg.tabId });
  assert.equal("isError" in r1, false, JSON.stringify(r1));
  assert.match(r1.content[0].text, /^No elements found\.\n\nViewport: \d+x\d+$/);

  const text = await openPage(browser, { html: "<p>Only text here.</p>" });
  const textBg = await loadBackground({ page: text, content: await injectContentScript(text, CONTENT) });
  const r2 = await textBg.handlers.read_page({ tabId: textBg.tabId, filter: "interactive" });
  assert.equal("isError" in r2, false, JSON.stringify(r2));
  assert.match(r2.content[0].text, /^No interactive elements found\.\n\nViewport: \d+x\d+$/);
});

// Real V8 puts only "Uncaught" in exceptionDetails.text. The error itself is in the exception's
// description.
test("real Chrome: javascript_tool replies with the exception's description", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const page = await openPage(browser, { html: "<p>x</p>" });
  const bg = await loadBackground({ page });
  const thrown = await bg.handlers.javascript_tool({ text: "throw new Error('boom from the page')", tabId: bg.tabId });
  assert.equal(thrown.isError, true);
  assert.match(thrown.content[0].text, /^Error: Error: boom from the page/);
  const parse = await bg.handlers.javascript_tool({ text: "JSON.parse('{not json')", tabId: bg.tabId });
  assert.equal(parse.isError, true);
  assert.match(parse.content[0].text, /^Error: SyntaxError: .*JSON/);
});

test("real Chrome: read_page with an unknown ref_id replies with isError", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const page = await openPage(browser, { html: "<button>Go</button>" });
  const cs = await injectContentScript(page, CONTENT);
  const bg = await loadBackground({ page, content: cs });
  const r = await bg.handlers.read_page({ tabId: bg.tabId, ref_id: "ref_999" });
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, 'Error: ref_id "ref_999" not found or element was garbage collected.');
});

test("a batch whose actions all succeed runs them all and carries no isError", async () => {
  const bg = await loadBackground();
  const r = await bg.handlers.browser_batch({
    actions: [
      { name: "computer", input: { action: "screenshot", tabId: 11 } },
      { name: "computer", input: { action: "key", text: "Enter", tabId: 11 } },
    ],
  });
  assert.equal("isError" in r, false);
  assert.equal(bg.calls.filter((c) => c[0] === "cdp" && c[1] === "Input.dispatchKeyEvent").length, 2);
});

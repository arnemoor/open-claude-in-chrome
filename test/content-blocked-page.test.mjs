// Round 2 item 8: tabAccessError (background.js) checks chrome.tabs.get(tabId).url before
// dispatching a message to content.js, but the page can navigate in the gap between that check
// and the content script actually handling the message (e.g. a timed history.back()). content.js
// now refuses any message when the page's own live location is file: or this extension's own
// origin, as a backstop.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadBackground } from "./harness/fake-chrome.mjs";
import { chromeAvailable, launchChrome, openPage, injectContentScript } from "./harness/browser.mjs";

const CONTENT = path.join(import.meta.dirname, "..", "extension", "content.js");
const BLOCKED_TEXT = "This tab shows a local file or this extension's own page, which the agent cannot use.";

test("isBlockedPage: pure logic for file:, own-origin and ordinary pages", () => {
  const src = fs.readFileSync(CONTENT, "utf8");
  const start = src.indexOf("function isBlockedPage()");
  assert.ok(start > 0, "expected to find isBlockedPage in content.js");
  const constIdx = src.indexOf("const BLOCKED_PAGE_TEXT", start);
  assert.ok(constIdx > start, "expected BLOCKED_PAGE_TEXT after isBlockedPage");
  const end = src.indexOf("\n", constIdx) + 1;
  const snippet = src.slice(start, end);

  const run = (protocol, origin, ownId) => {
    const fn = new Function("location", "chrome", `${snippet}\nreturn isBlockedPage();`);
    return fn({ protocol, origin }, { runtime: { id: ownId } });
  };
  assert.equal(run("file:", "file://", "abc"), true);
  assert.equal(run("https:", "chrome-extension://abc", "abc"), true);
  assert.equal(run("https:", "chrome-extension://otherid", "abc"), false, "a different extension's page is not this extension's own page");
  assert.equal(run("https:", "https://example.com", "abc"), false);
  assert.equal(run("about:", "null", "abc"), false);
});

// Fake harness: content.invoke always returns the blocked shape, regardless of message type,
// pinning that background.js surfaces it correctly for every message-consuming handler instead
// of garbling it (findElements in particular: without an explicit check, an {error} object gets
// treated as an array and iterated character-by-character over its own string keys).
const blockedContent = { invoke: async () => ({ result: { error: BLOCKED_TEXT } }) };

test("read_page surfaces a blocked-page response from content.js instead of garbling it", async () => {
  const bg = await loadBackground({ content: blockedContent });
  const r = await bg.handlers.read_page({ tabId: bg.tabId });
  assert.equal(r.content[0].text, BLOCKED_TEXT);
});

test("get_page_text surfaces a blocked-page response from content.js instead of garbling it", async () => {
  const bg = await loadBackground({ content: blockedContent });
  const r = await bg.handlers.get_page_text({ tabId: bg.tabId });
  assert.equal(r.content[0].text, BLOCKED_TEXT);
});

test("find surfaces a blocked-page response from content.js instead of treating it as a result array", async () => {
  const bg = await loadBackground({ content: blockedContent });
  const r = await bg.handlers.find({ query: "x", tabId: bg.tabId });
  assert.equal(r.content[0].text, BLOCKED_TEXT);
});

test("a coordinate click surfaces a blocked-page response from probePoint instead of clicking anyway", async () => {
  const bg = await loadBackground({ content: blockedContent });
  const r = await bg.handlers.computer({ action: "left_click", coordinate: [10, 10], tabId: bg.tabId });
  assert.equal(r.content[0].text, BLOCKED_TEXT);
  assert.equal(bg.calls.filter((c) => c[1] === "Input.dispatchMouseEvent").length, 0, "must not dispatch the click once the page turns out to be blocked");
});

let browser;
before(async () => { if (chromeAvailable) browser = await launchChrome(); }, { timeout: 30000 });
after(() => browser?.close());

test("real Chrome: content.js refuses every message on a file: page", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync("/tmp/ocic-content-test-");
  try {
    const filePath = path.join(dir, "test.html");
    fs.writeFileSync(filePath, "<button>Go</button>");
    const page = await openPage(browser, { url: `file://${filePath}` });
    const cs = await injectContentScript(page, CONTENT);

    const text = await cs.invoke({ type: "getPageText" });
    assert.deepEqual(text.result, { error: BLOCKED_TEXT });

    const found = await cs.invoke({ type: "findElements", query: "go" });
    assert.deepEqual(found.result, { error: BLOCKED_TEXT });

    const tree = await cs.invoke({ type: "generateAccessibilityTree", options: {} });
    assert.deepEqual(tree.result, { error: BLOCKED_TEXT });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

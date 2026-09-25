// Item 1 (final-review-a C1 / final-review-b Minor 3): every tool that takes a tabId refuses a
// tab that currently shows a local file or this extension's own page — not just an explicit
// navigate there (which normalizeNavigateUrl already blocks in navigate.test.mjs), but also a
// tab that simply already IS on such a page, e.g. after back/forward or because the options tab
// ended up dragged into the MCP group.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadBackground } from "./harness/fake-chrome.mjs";
import { chromeAvailable, launchChrome, openPage } from "./harness/browser.mjs";

const refusalFor = (tabId) => `Tab ${tabId} shows a local file or this extension's own page, which the agent cannot use.`;

test("a tab showing a local file is refused, whatever tool is called", async () => {
  const bg = await loadBackground({ tab: { url: "file:///Users/x/secret.txt" } });
  const r1 = await bg.handlers.get_page_text({ tabId: bg.tabId });
  assert.equal(r1.content[0].text, refusalFor(bg.tabId));
  const r2 = await bg.handlers.computer({ action: "screenshot", tabId: bg.tabId });
  assert.equal(r2.content[0].text, refusalFor(bg.tabId));
  const r3 = await bg.handlers.tabs_close_mcp({ tabId: bg.tabId });
  assert.equal(r3.content[0].text, refusalFor(bg.tabId));
  // Refused upfront: no CDP call and no content-script message ever went out.
  assert.equal(bg.calls.filter((c) => c[0] === "cdp" || c[0] === "tabs.sendMessage" || c[0] === "tabs.remove").length, 0);
});

test("a tab showing this extension's own page is refused", async () => {
  const bg = await loadBackground({ tab: { url: "chrome-extension://testextensionid/options.html" } });
  const r = await bg.handlers.find({ query: "x", tabId: bg.tabId });
  assert.equal(r.content[0].text, refusalFor(bg.tabId));
});

test("a view-source:-wrapped own-page tab is refused too", async () => {
  const bg = await loadBackground({ tab: { url: "view-source:chrome-extension://testextensionid/options.html" } });
  const r = await bg.handlers.read_page({ tabId: bg.tabId });
  assert.equal(r.content[0].text, refusalFor(bg.tabId));
});

test("an ordinary tab is not blocked", async () => {
  const bg = await loadBackground(); // default tab.url is https://example.test/
  const r = await bg.handlers.computer({ action: "screenshot", tabId: bg.tabId });
  assert.doesNotMatch(r.content[0].text, /shows a local file/);
});

test("tabs_context_mcp lists a blocked tab's URL as (blocked) with no title", async () => {
  const bg = await loadBackground({
    overrides: {
      tabs: {
        query: async () => [
          { id: 11, windowId: 1, groupId: 7, title: "Open Claude in Chrome Options", url: "chrome-extension://testextensionid/options.html" },
          { id: 12, windowId: 1, groupId: 7, title: "Example", url: "https://example.test/" },
        ],
      },
    },
  });
  const r = await bg.handlers.tabs_context_mcp({ createIfEmpty: true });
  const text = r.content[0].text;
  const parsed = JSON.parse(text.split("\n\n")[0]);
  assert.deepEqual(parsed.availableTabs.find((t) => t.tabId === 11), { tabId: 11, title: "", url: "(blocked)" });
  assert.deepEqual(parsed.availableTabs.find((t) => t.tabId === 12), { tabId: 12, title: "Example", url: "https://example.test/" });
  assert.doesNotMatch(text, /Open Claude in Chrome Options/);
  assert.match(text, /tabId 11: \(blocked\)/);
});

let browser;
before(async () => { if (chromeAvailable) browser = await launchChrome(); }, { timeout: 30000 });
after(() => browser?.close());

// Minor 3: a real tab, with real CDP plumbing wired up (so if the check were missing, these
// calls would really attach the debugger / message the content script), refused before either
// ever happens.
test("real Chrome: a group tab already on the extension's own page refuses get_page_text and screenshot", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const page = await openPage(browser, { html: "<h1>Options</h1>" });
  const bg = await loadBackground({ page, tab: { url: "chrome-extension://testextensionid/options.html", title: "Open Claude in Chrome Options" } });

  const text = await bg.handlers.get_page_text({ tabId: bg.tabId });
  assert.equal(text.content[0].text, refusalFor(bg.tabId));

  const shot = await bg.handlers.computer({ action: "screenshot", tabId: bg.tabId });
  assert.equal(shot.content.length, 1, "no image block on a refusal");
  assert.equal(shot.content[0].text, refusalFor(bg.tabId));

  assert.equal(bg.calls.filter((c) => c[0] === "debugger.attach").length, 0, "must not attach CDP to a blocked tab");
  assert.equal(bg.calls.filter((c) => c[0] === "tabs.sendMessage").length, 0, "must not message the content script on a blocked tab");
});

// [290]: pin the own-id refusals through Chrome's own URL parser, not Node's — Node's leaves a
// non-special scheme's host untouched for several of these (no slash, one or three slashes,
// backslash, percent-encoded), so it can't demonstrate that production (which runs inside real
// Chrome) actually refuses them. Extracts the real isBlockedUrl/unwrapViewSourceOrBlob source
// (not a re-typed copy) so a change to that logic is pinned here too.
test("real Chrome: own-id refusals hold for slash, backslash, percent-encoding, case, userinfo, port and deep view-source variants", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const bgSource = fs.readFileSync(path.join(import.meta.dirname, "..", "extension", "background.js"), "utf8");
  const start = bgSource.indexOf("const MAX_UNWRAPS");
  const end = bgSource.indexOf("function normalizeNavigateUrl");
  assert.ok(start > 0 && end > start, "expected to find the isBlockedUrl source region in background.js");
  const urlHelpers = bgSource.slice(start, end);

  const OWN = "testextensionid";
  const variants = {
    noSlash: `chrome-extension:${OWN}/p.html`,
    oneSlash: `chrome-extension:/${OWN}/p.html`,
    threeSlashes: `chrome-extension:///${OWN}/p.html`,
    backslash: `chrome-extension:\\\\${OWN}/p.html`,
    percentEncoded: `chrome-extension://t%65stextensionid/p.html`,
    uppercase: `chrome-extension://${OWN.toUpperCase()}/p.html`,
    userinfo: `chrome-extension://user:pass@${OWN}/p.html`,
    port: `chrome-extension://${OWN}:1234/p.html`,
    tabInHost: `chrome-extension://te\tstextensionid/p.html`,
    viewSourceFourDeep: `view-source:view-source:view-source:view-source:chrome-extension://${OWN}/p.html`,
    otherIdNotBlocked: `chrome-extension://otherid/p.html`,
  };

  const page = await openPage(browser, { html: "<body>x</body>" });
  const expr = `${urlHelpers}\nJSON.stringify(Object.fromEntries(Object.entries(${JSON.stringify(variants)}).map(([k, u]) => [k, isBlockedUrl(u, ${JSON.stringify(OWN)})])))`;
  const results = JSON.parse(await page.evaluate(expr));

  for (const key of Object.keys(variants)) {
    if (key === "otherIdNotBlocked") {
      assert.equal(results[key], false, `${key} must not be blocked (different extension id)`);
    } else {
      assert.equal(results[key], true, `${key} must be blocked: ${variants[key]}`);
    }
  }
});

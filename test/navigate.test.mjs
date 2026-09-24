import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBackground } from "./harness/fake-chrome.mjs";

test("normalizeNavigateUrl", async () => {
  const bg = await loadBackground();
  const n = (u) => ({ ...bg.get("normalizeNavigateUrl")(u, "testextensionid") }); // spread: vm-realm objects fail strict deepEqual
  assert.deepEqual(n("example.com"), { url: "https://example.com" });
  assert.deepEqual(n("  https://example.com/a?b=1  "), { url: "https://example.com/a?b=1" });
  assert.deepEqual(n("http://localhost:3000"), { url: "http://localhost:3000" });
  assert.deepEqual(n("localhost:3000"), { url: "https://localhost:3000" });
  assert.deepEqual(n("hps://example.com"), { url: "https://example.com" });
  assert.deepEqual(n("file:///tmp/x.html"), { url: "file:///tmp/x.html" });
  assert.deepEqual(n("data:text/html,<h1>x</h1>"), { url: "data:text/html,<h1>x</h1>" });
  assert.deepEqual(n("about:blank"), { url: "about:blank" });
  assert.deepEqual(n("view-source:https://example.com"), { url: "view-source:https://example.com" });
  assert.deepEqual(n("chrome-extension://otherid/p.html"), { url: "chrome-extension://otherid/p.html" });
  assert.match(n("javascript:alert(1)").error, /javascript: URLs are not allowed/);
  assert.match(n("chrome-extension://testextensionid/options.html").error, /own pages cannot be opened/);
  assert.match(n("http://[bad").error, /Invalid URL/);
  // I1: view-source:/blob: wrapping the extension's own chrome-extension: origin is refused,
  // however deeply nested; wrapping another id, or a non-chrome-extension URL, stays allowed.
  assert.match(n("view-source:chrome-extension://testextensionid/options.html").error, /own pages cannot be opened/);
  assert.match(n("blob:chrome-extension://testextensionid/0b0e1c2d-uuid").error, /own pages cannot be opened/);
  assert.match(n("view-source:view-source:chrome-extension://testextensionid/p.html").error, /own pages cannot be opened/);
  assert.deepEqual(n("view-source:chrome-extension://otherid/p.html"), { url: "view-source:chrome-extension://otherid/p.html" });
  // M3: the own-id compare is case-insensitive on the host.
  assert.match(n("chrome-extension://TESTEXTENSIONID/options.html").error, /own pages cannot be opened/);
});

test("a failed file: navigation explains how to allow file access", async () => {
  const bg = await loadBackground({ overrides: { tabs: { update: async () => { throw new Error("Cannot access file URL"); } } } });
  const r = await bg.handlers.navigate({ url: "file:///tmp/x.html", tabId: bg.tabId });
  assert.match(r.content[0].text, /^Could not navigate to file:\/\/\/tmp\/x\.html: Cannot access file URL\. To open local files, enable "Allow access to file URLs"/);
});

// M2/M1: the same hint on the success path, where chrome.tabs.update doesn't throw but the
// tab settles somewhere other than the requested file: URL (e.g. file access is disabled).
// update fires onUpdated asynchronously (a macrotask) so it lands after navigate's listener
// is registered, instead of waiting out the handler's real 10s no-event fallback.
async function fileHintScenario(tabUrl) {
  let bg;
  const update = async () => { setTimeout(() => bg.chrome.tabs.onUpdated.fire(bg.tabId, { status: "complete" }), 0); };
  bg = await loadBackground({ tab: { url: tabUrl }, overrides: { tabs: { update } } });
  return bg;
}

test("a file: navigation that silently settles elsewhere still gets the hint", async () => {
  const bg = await fileHintScenario("chrome-error://chromewebdata/");
  const r = await bg.handlers.navigate({ url: "file:///tmp/x.html", tabId: bg.tabId });
  assert.match(r.content[0].text, /To open local files, enable "Allow access to file URLs"/);
});

test("an uppercase FILE: request that settles elsewhere still gets the hint", async () => {
  const bg = await fileHintScenario("chrome-error://chromewebdata/");
  const r = await bg.handlers.navigate({ url: "FILE:///tmp/x.html", tabId: bg.tabId });
  assert.match(r.content[0].text, /To open local files, enable "Allow access to file URLs"/);
});

test("a file: navigation that actually lands on file: gets no hint", async () => {
  const bg = await fileHintScenario("file:///tmp/x.html");
  const r = await bg.handlers.navigate({ url: "file:///tmp/x.html", tabId: bg.tabId });
  assert.doesNotMatch(r.content[0].text, /Allow access to file URLs/);
});

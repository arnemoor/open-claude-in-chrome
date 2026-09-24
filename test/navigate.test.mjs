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
});

test("a failed file: navigation explains how to allow file access", async () => {
  const bg = await loadBackground({ overrides: { tabs: { update: async () => { throw new Error("Cannot access file URL"); } } } });
  const r = await bg.handlers.navigate({ url: "file:///tmp/x.html", tabId: bg.tabId });
  assert.match(r.content[0].text, /^Could not navigate to file:\/\/\/tmp\/x\.html: Cannot access file URL\. To open local files, enable "Allow access to file URLs"/);
});

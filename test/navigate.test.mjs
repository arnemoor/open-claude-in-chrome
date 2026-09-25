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
  assert.deepEqual(n("data:text/html,<h1>x</h1>"), { url: "data:text/html,<h1>x</h1>" });
  assert.deepEqual(n("about:blank"), { url: "about:blank" });
  assert.deepEqual(n("view-source:https://example.com"), { url: "view-source:https://example.com" });
  assert.deepEqual(n("chrome-extension://otherid/p.html"), { url: "chrome-extension://otherid/p.html" });
  assert.match(n("javascript:alert(1)").error, /javascript: URLs are not allowed/);
  assert.match(n("chrome-extension://testextensionid/options.html").error, /own pages cannot be opened/);
  assert.match(n("http://[bad").error, /Invalid URL/);
  // I1: view-source:/blob: wrapping the extension's own chrome-extension: origin is refused,
  // however deeply nested (up to the wrapper limit); wrapping another id, or a non-chrome-extension
  // URL, stays allowed.
  assert.match(n("view-source:chrome-extension://testextensionid/options.html").error, /own pages cannot be opened/);
  assert.match(n("blob:chrome-extension://testextensionid/0b0e1c2d-uuid").error, /own pages cannot be opened/);
  assert.match(n("view-source:view-source:chrome-extension://testextensionid/p.html").error, /own pages cannot be opened/);
  assert.deepEqual(n("view-source:chrome-extension://otherid/p.html"), { url: "view-source:chrome-extension://otherid/p.html" });
  // M3: the own-id compare is case-insensitive on the host.
  assert.match(n("chrome-extension://TESTEXTENSIONID/options.html").error, /own pages cannot be opened/);
});

// Item 1 (Arne's decision, final-review-a C1): unpacked extensions get file: access by default,
// so an unblocked file: navigate plus get_page_text would read any local file regardless of the
// upload allowlist. Blocked outright, in any case, and behind view-source:/blob:.
test("file: URLs are blocked, in any case and behind view-source:/blob:", async () => {
  const bg = await loadBackground();
  const n = (u) => bg.get("normalizeNavigateUrl")(u, "testextensionid");
  const BLOCKED = /^file: URLs are blocked: the agent cannot open local files\.$/;
  assert.match(n("file:///tmp/x.html").error, BLOCKED);
  assert.match(n("FILE:///tmp/x.html").error, BLOCKED);
  assert.match(n("File:///Users/arm/.ssh/id_ed25519").error, BLOCKED);
  assert.match(n("view-source:file:///tmp/x.html").error, BLOCKED);
  assert.match(n("blob:file:///tmp/x.html").error, BLOCKED);
  assert.match(n("view-source:blob:file:///tmp/x.html").error, BLOCKED);
});

test("navigate refuses a file: URL without touching the tab", async () => {
  const bg = await loadBackground({ overrides: { tabs: { update: async () => { throw new Error("must not be called"); } } } });
  const r = await bg.handlers.navigate({ url: "file:///tmp/x.html", tabId: bg.tabId });
  assert.equal(r.content[0].text, "file: URLs are blocked: the agent cannot open local files.");
  assert.equal(bg.calls.filter((c) => c[0] === "tabs.update").length, 0);
});

// Minor 5: the unwrap has no depth limit upstream of this fix, and re-parses the whole
// remaining string at every layer — quadratic in the wrapper count.
test("more than 4 nested view-source:/blob: wrappers is refused; exactly 4 is not", async () => {
  const bg = await loadBackground();
  const n = (u) => bg.get("normalizeNavigateUrl")(u, "testextensionid");
  assert.deepEqual({ ...n("view-source:".repeat(4) + "https://example.com") }, { url: "view-source:".repeat(4) + "https://example.com" });
  assert.match(n("view-source:".repeat(5) + "https://example.com").error, /Too many nested view-source:\/blob: wrappers\./);
  assert.match(n("blob:".repeat(5) + "https://example.com").error, /Too many nested view-source:\/blob: wrappers\./);
});

test("a ~1MB deeply nested wrapper is refused quickly, not quadratically", async () => {
  const bg = await loadBackground();
  const n = (u) => bg.get("normalizeNavigateUrl")(u, "testextensionid");
  const wrapped = "view-source:".repeat(90000) + "https://example.com/"; // ~1.08MB of wrapper prefixes
  const start = Date.now();
  const result = n(wrapped);
  const elapsed = Date.now() - start;
  assert.match(result.error, /Too many nested view-source:\/blob: wrappers\./);
  assert.ok(elapsed < 2000, `expected a fast refusal, took ${elapsed}ms`);
});

// [298]: the 10s wait-for-load fallback timer used to keep running (and re-fire, harmlessly but
// wastefully) after the page had already loaded and the promise had already resolved.
test("navigate clears its wait-for-load fallback timer once the page settles", async () => {
  const clearedIds = [];
  let bg;
  const update = async () => { setTimeout(() => bg.chrome.tabs.onUpdated.fire(bg.tabId, { status: "complete" }), 0); };
  bg = await loadBackground({
    overrides: { tabs: { update } },
    beforeRun: (ctx) => {
      const real = ctx.clearTimeout;
      ctx.clearTimeout = (id) => { clearedIds.push(id); return real(id); };
    },
  });
  await bg.handlers.navigate({ url: "https://example.com", tabId: bg.tabId });
  assert.ok(clearedIds.length > 0, "expected the fallback timer to be cleared once the page loaded");
});

// Item 1: back/forward can land on a local file or this extension's own page even though the
// explicit-url path above already refuses navigating there directly. The reply must not leak
// the resulting title/URL.
test("navigate refuses instead of revealing the title when back lands on a blocked page", async () => {
  let getCalls = 0;
  let bg;
  const goBack = async () => { setTimeout(() => bg.chrome.tabs.onUpdated.fire(bg.tabId, { status: "complete" }), 0); };
  bg = await loadBackground({
    overrides: {
      tabs: {
        goBack,
        get: async (id) => {
          getCalls++;
          return getCalls === 1
            ? { id, windowId: 1, groupId: 7, status: "complete", url: "https://example.test/" }
            : { id, windowId: 1, groupId: 7, status: "complete", url: "file:///Users/x/secret.txt", title: "secret.txt" };
        },
      },
    },
  });
  const r = await bg.handlers.navigate({ url: "back", tabId: bg.tabId });
  assert.equal(r.content[0].text, `Tab ${bg.tabId} shows a local file or this extension's own page, which the agent cannot use.`);
  assert.doesNotMatch(r.content[0].text, /secret\.txt/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBackground } from "./harness/fake-chrome.mjs";
import { chromeAvailable, launchChrome, openPage, jpegSize } from "./harness/browser.mjs";

test("parallel first calls on a cold tab attach once and both succeed", async () => {
  const bg = await loadBackground();
  const results = await Promise.allSettled([
    bg.handlers.computer({ action: "screenshot", tabId: bg.tabId }),
    bg.handlers.javascript_tool({ action: "javascript_exec", text: "1", tabId: bg.tabId }),
  ]);
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled"]);
  assert.equal(bg.calls.filter((c) => c[0] === "debugger.attach").length, 1);
});

test("the dpr is pinned without overriding the size", async () => {
  const bg = await loadBackground();
  await bg.handlers.javascript_tool({ action: "javascript_exec", text: "1", tabId: bg.tabId });
  const emu = bg.calls.find((c) => c[1] === "Emulation.setDeviceMetricsOverride");
  // emu[2] is a plain object literal constructed inside background.js's vm realm, so it has a
  // different Object.prototype than this file's realm. Spread it into an outer-realm plain
  // object first: assert/strict's deepEqual (= deepStrictEqual) checks prototype identity and
  // would otherwise throw "same structure but not reference-equal" even on matching values.
  assert.deepEqual({ ...emu[2] }, { width: 0, height: 0, deviceScaleFactor: 1, mobile: false });
});

test("a failed attach is retried by the next call", async () => {
  let fails = 1;
  const bg = await loadBackground({ overrides: { debugger: { attach: async () => { if (fails-- > 0) throw new Error("boom"); } } } });
  await assert.rejects(bg.get("ensureAttached")(bg.tabId), /boom/);
  await bg.get("ensureAttached")(bg.tabId);
});

test("a hung CDP command times out instead of hanging the call", async () => {
  const bg = await loadBackground({ overrides: { debugger: { sendCommand: async (t, method) => (method === "Hang.me" ? new Promise(() => {}) : {}) } } });
  await assert.rejects(bg.get("cdp")(bg.tabId, "Hang.me", {}, 50), /CDP Hang\.me timed out/);
});

test("real Chrome: the viewport follows a window resize and screenshots stay 1x on a 2x display", { skip: !chromeAvailable }, async () => {
  const browser = await launchChrome({ args: ["--force-device-scale-factor=2"] });
  try {
    const page = await openPage(browser, { html: "<body style='margin:0'>x</body>" });
    const bg = await loadBackground({ page });
    const shot = await bg.handlers.computer({ action: "screenshot", tabId: bg.tabId });
    const [w, h] = jpegSize(shot.content[1].data);
    const [iw, ih] = await page.evaluate("[innerWidth, innerHeight]");
    assert.deepEqual([w, h], [iw, ih]);
    const { windowId } = await browser.send("Browser.getWindowForTarget", { targetId: page.targetId });
    await browser.send("Browser.setWindowBounds", { windowId, bounds: { width: 900, height: 600, windowState: "normal" } });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await page.evaluate("innerWidth"), 900);
  } finally {
    browser.close();
  }
});

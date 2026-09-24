import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBackground } from "./harness/fake-chrome.mjs";

test("un-maximizes before resizing and reports real sizes", async () => {
  let state = "maximized";
  let size = { width: 1400, height: 900 };
  const bg = await loadBackground({ overrides: { windows: {
    get: async (id) => ({ id, state, ...size }),
    update: async (id, p) => { if (p.state) state = p.state; if (p.width) size = { width: p.width, height: p.height }; },
  }, debugger: { sendCommand: async (t, m) => (m === "Runtime.evaluate" ? { result: { value: [size.width, size.height - 87] } } : {}) } } });
  const r = await bg.handlers.resize_window({ width: 900, height: 600, tabId: bg.tabId });
  assert.equal(state, "normal");
  assert.equal(r.content[0].text, "Resized window to 900x600 (viewport 900x513).");
});

test("says so when the browser limits the size", async () => {
  const bg = await loadBackground({ overrides: { windows: {
    get: async (id) => ({ id, state: "normal", width: 500, height: 400 }),
    update: async () => {},
  }, debugger: { sendCommand: async (t, m) => (m === "Runtime.evaluate" ? { result: { value: [500, 313] } } : {}) } } });
  const r = await bg.handlers.resize_window({ width: 200, height: 100, tabId: bg.tabId });
  assert.match(r.content[0].text, /^Resized window to 500x400 \(viewport 500x313\)\. Requested 200x100: the browser limited the size/);
});

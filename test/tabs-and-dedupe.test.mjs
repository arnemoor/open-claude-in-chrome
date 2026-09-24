import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBackground } from "./harness/fake-chrome.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("tabs_create_mcp opens the tab in the group's window", async () => {
  const bg = await loadBackground();
  await bg.handlers.tabs_create_mcp({});
  const create = bg.calls.find((c) => c[0] === "tabs.create");
  assert.deepEqual({ ...create[1] }, { windowId: 1, active: true }); // spread: vm-realm objects fail strict deepEqual
});

test("a repeated request id is executed once", async () => {
  const bg = await loadBackground();
  const req = { type: "tool_request", id: "run1.s1.7", tool: "computer", args: { action: "screenshot", tabId: bg.tabId } };
  bg.deliver(req);
  bg.deliver(req);
  await sleep(200);
  assert.equal(bg.calls.filter((c) => c[1] === "Page.captureScreenshot").length, 1);
  assert.equal(bg.posted.filter((m) => m.id === req.id).length, 1);
});

test("different ids both run, and old ids fall out after 500 newer ones", async () => {
  const bg = await loadBackground();
  const first = bg.get("firstDelivery");
  assert.equal(first("a"), true);
  assert.equal(first("a"), false);
  for (let i = 0; i < 500; i++) first(`x${i}`);
  assert.equal(first("a"), true);
});

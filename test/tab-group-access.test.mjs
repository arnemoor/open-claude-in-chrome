// The MCP tab group is the only access boundary: a tab counts as in it only while Chrome says
// so right now. A tab the extension once cached but that the user has since dragged out of the
// group (or popped into its own window) is refused, and what the extension still held for it is
// released.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBackground } from "./harness/fake-chrome.mjs";

const TAB = { windowId: 1, status: "complete", url: "https://example.test/" };
const flush = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test("a cached tab that is no longer in the MCP group is refused", async () => {
  let groupId = 7;
  const bg = await loadBackground({ overrides: { tabs: { get: async (id) => ({ ...TAB, id, groupId }) } } });
  const inside = await bg.handlers.computer({ action: "screenshot", tabId: 11 });
  assert.equal("isError" in inside, false, JSON.stringify(inside));
  assert.ok(bg.get("tabGroupTabs").has(11), "the extension cached tab 11 as a group member");

  groupId = -1; // dragged out of the group: no event has reached the extension yet
  const shots = bg.calls.filter((c) => c[1] === "Page.captureScreenshot").length;
  const outside = await bg.handlers.computer({ action: "screenshot", tabId: 11 });
  assert.equal(outside.isError, true);
  assert.equal(outside.content[0].text, "Tab 11 is not in the MCP group.");
  assert.equal(bg.calls.filter((c) => c[1] === "Page.captureScreenshot").length, shots, "no screenshot of a tab outside the group");
});

test("a tab leaving the MCP group is detached and its console, network and dialog state is cleared", async () => {
  let groupId = 7;
  const bg = await loadBackground({ overrides: { tabs: { get: async (id) => ({ ...TAB, id, groupId }) } } });
  await bg.handlers.computer({ action: "screenshot", tabId: 11 }); // attaches the debugger
  bg.chrome.debugger.onEvent.fire({ tabId: 11 }, "Runtime.consoleAPICalled", { type: "log", args: [{ value: "private log line" }] });
  bg.chrome.debugger.onEvent.fire({ tabId: 11 }, "Network.requestWillBeSent", { requestId: "r1", request: { url: "https://example.test/private", method: "GET" }, type: "Fetch" });
  bg.chrome.debugger.onEvent.fire({ tabId: 11 }, "Page.javascriptDialogOpening", { message: "hi" });
  assert.ok(bg.get("attachedTabs").has(11) && bg.get("consoleMessages").has(11) && bg.get("networkRequests").has(11) && bg.get("openDialogs").has(11));

  groupId = -1;
  bg.chrome.tabs.onUpdated.fire(11, { groupId: -1 }, { ...TAB, id: 11, groupId: -1 });
  await flush();

  assert.ok(bg.calls.some((c) => c[0] === "debugger.detach" && c[1] === 11), "expected the debugger to be detached from the tab");
  for (const state of ["attachedTabs", "consoleMessages", "networkRequests", "openDialogs", "tabGroupTabs"]) {
    assert.equal(bg.get(state).has(11), false, `${state} still holds tab 11`);
  }
});

test("a tab moved into another group is released the same way, and a tab dragged into the MCP group is tracked", async () => {
  const bg = await loadBackground();
  await bg.handlers.computer({ action: "screenshot", tabId: 11 });
  bg.chrome.tabs.onUpdated.fire(11, { groupId: 8 }, { ...TAB, id: 11, groupId: 8 });
  await flush();
  assert.ok(bg.calls.some((c) => c[0] === "debugger.detach" && c[1] === 11));
  assert.equal(bg.get("tabGroupTabs").has(11), false);

  bg.chrome.tabs.onUpdated.fire(11, { groupId: 7 }, { ...TAB, id: 11, groupId: 7 });
  assert.equal(bg.get("tabGroupTabs").has(11), true);
});

// The call already passed its group check, so only the release can stop it: its next CDP command
// would otherwise attach the debugger again and go on typing into the tab the user took back.
test("a type call in flight when its tab leaves the group sends no further key event", async () => {
  const bg = await loadBackground();
  const keyEvents = () => bg.calls.filter((c) => c[0] === "cdp" && c[1] === "Input.dispatchKeyEvent").length;
  const typing = bg.handlers.computer({ action: "type", text: "abcdefghijklmnopqrstuvwxyz", tabId: 11 });
  await flush(80); // a few characters in
  bg.chrome.tabs.onUpdated.fire(11, { groupId: -1 }, { ...TAB, id: 11, groupId: -1 });
  const sentAtLeave = keyEvents();
  await assert.rejects(typing, /Tab 11 is not in the MCP group/);
  assert.ok(sentAtLeave > 0 && sentAtLeave < 52, `expected the typing to be under way, sent ${sentAtLeave}`);
  assert.equal(keyEvents(), sentAtLeave, "no key event after the tab left the group");
  assert.equal(bg.get("attachedTabs").has(11), false);
});

test("a tab that leaves the group while its debugger is still attaching is detached once the attach completes", async () => {
  let releaseAttach;
  const attachGate = new Promise((resolve) => { releaseAttach = resolve; });
  const bg = await loadBackground({
    overrides: { debugger: { attach: async ({ tabId }) => { bg.calls.push(["debugger.attach", tabId]); await attachGate; } } },
  });
  const shot = bg.handlers.computer({ action: "screenshot", tabId: 11 });
  await flush();
  bg.chrome.tabs.onUpdated.fire(11, { groupId: -1 }, { ...TAB, id: 11, groupId: -1 });
  releaseAttach();
  await shot.catch(() => {});
  await flush();
  assert.ok(bg.calls.some((c) => c[0] === "debugger.detach" && c[1] === 11), "expected a detach after the late attach");
  assert.equal(bg.get("attachedTabs").has(11), false);
});

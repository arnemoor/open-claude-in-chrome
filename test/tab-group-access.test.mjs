// The MCP tab group is the only access boundary. Only the group this extension created counts:
// after a service worker restart it is found again by the id stored in session storage, never by
// its title. A tab counts as in it only while Chrome says so right now: a tab the extension once
// cached but that the user has since dragged out of the group (or popped into its own window) is
// refused, and what the extension still held for it is released.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBackground } from "./harness/fake-chrome.mjs";

const TAB = { windowId: 1, status: "complete", url: "https://example.test/" };
const flush = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

// --- A service worker restart adopts only the group this extension created ---

// A fresh worker with explicit session storage (`stored`), never the harness default. `groups`
// are the groups Chrome reports, in this order, with their tabs. Group 99 is the user's own group,
// titled "MCP" too. A group this extension creates gets id 8, in a new window whose tab is 21.
async function restartedWorker({ stored, groups }) {
  const session = { ...stored };
  const log = [];
  const tabs = {};
  for (const g of groups) for (const id of g.tabIds) tabs[id] = { ...TAB, id, groupId: g.id, title: `tab ${id}` };
  const groupList = groups.map(({ id, title }) => ({ id, title }));
  const bg = await loadBackground({
    overrides: {
      storage: {
        session: {
          get: async (key) => (key in session ? { [key]: session[key] } : {}),
          set: async (items) => { log.push(["storage.session.set", { ...items }]); Object.assign(session, items); },
          remove: async (key) => { log.push(["storage.session.remove", key]); delete session[key]; },
        },
      },
      tabGroups: {
        get: async (id) => { const g = groupList.find((x) => x.id === id); if (!g) throw new Error(`No group with id: ${id}.`); return g; },
        query: async ({ title } = {}) => groupList.filter((g) => title === undefined || g.title === title),
        update: async (id, props) => { log.push(["tabGroups.update", id, { ...props }]); Object.assign(groupList.find((g) => g.id === id), props); },
      },
      tabs: {
        get: async (id) => { if (!tabs[id]) throw new Error(`No tab with id: ${id}.`); return tabs[id]; },
        query: async ({ groupId } = {}) => Object.values(tabs).filter((t) => t.groupId === groupId),
        group: async ({ tabIds, groupId }) => {
          log.push(["tabs.group", [...tabIds], groupId]);
          const id = groupId ?? 8;
          if (!groupList.some((g) => g.id === id)) groupList.push({ id, title: "" });
          for (const tabId of tabIds) tabs[tabId].groupId = id;
          return id;
        },
      },
      windows: {
        create: async () => { log.push(["windows.create"]); tabs[21] = { ...TAB, id: 21, windowId: 2, groupId: -1, title: "", url: "about:blank" }; return { id: 2, tabs: [{ id: 21 }] }; },
      },
    },
  });
  await flush(); // let the startup recovery settle before the first call
  return { bg, session, log, tabs, groupList };
}

const listedTabs = (result) => JSON.parse(result.content[0].text.split("\n\n")[0]);

// Not adopted: tab 11 in the user's group is refused. On demand a group of its own is created and
// stored, and the user's group keeps its tabs, its title and its members.
async function assertUserGroupIgnored(w) {
  assert.equal((await w.bg.handlers.tabs_context_mcp({})).content[0].text, "No MCP tab group exists. Use createIfEmpty: true to create one.");
  const refused = await w.bg.handlers.get_page_text({ tabId: 11 });
  assert.equal(refused.isError, true);
  assert.equal(refused.content[0].text, "Tab 11 is not in the MCP group.");

  const created = listedTabs(await w.bg.handlers.tabs_context_mcp({ createIfEmpty: true }));
  assert.equal(created.tabGroupId, 8);
  assert.deepEqual(created.availableTabs.map((t) => t.tabId), [21]);
  assert.equal(w.session.mcpTabGroupId, 8, "the new group's id is stored");

  assert.equal(w.tabs[11].groupId, 99, "tab 11 stays in the user's group");
  assert.ok(!w.log.some(([op, a, b]) => op === "tabs.group" && (a.includes(11) || b === 99)), `no tab moved into or out of the user's group: ${JSON.stringify(w.log)}`);
  assert.ok(!w.log.some(([op, id]) => op === "tabGroups.update" && id === 99), "the user's group is not renamed");
  assert.equal((await w.bg.handlers.get_page_text({ tabId: 11 })).content[0].text, "Tab 11 is not in the MCP group.");
}

test("with nothing stored, a worker restart does not adopt the user's own MCP group", async () => {
  await assertUserGroupIgnored(await restartedWorker({ stored: {}, groups: [{ id: 99, title: "MCP", tabIds: [11] }] }));
});

test("a stored group id whose group is gone is not adopted, nor is the user's own MCP group", async () => {
  await assertUserGroupIgnored(await restartedWorker({ stored: { mcpTabGroupId: 5 }, groups: [{ id: 99, title: "MCP", tabIds: [11] }] }));
});

// The user's group comes first in Chrome's list, so a match by title would take it.
test("a stored group id that still exists is adopted after a worker restart", async () => {
  const w = await restartedWorker({ stored: { mcpTabGroupId: 7 }, groups: [{ id: 99, title: "MCP", tabIds: [50] }, { id: 7, title: "MCP", tabIds: [11] }] });
  const context = listedTabs(await w.bg.handlers.tabs_context_mcp({}));
  assert.equal(context.tabGroupId, 7);
  assert.deepEqual(context.availableTabs.map((t) => t.tabId), [11]);
  assert.equal("isError" in (await w.bg.handlers.computer({ action: "screenshot", tabId: 11 })), false);
  assert.equal((await w.bg.handlers.get_page_text({ tabId: 50 })).content[0].text, "Tab 50 is not in the MCP group.");
  assert.ok(!w.log.some(([op]) => op === "windows.create" || op === "tabs.group"), "no new group was created");
});

test("removing the MCP group forgets its stored id, and the next call creates a new group", async () => {
  const w = await restartedWorker({ stored: { mcpTabGroupId: 7 }, groups: [{ id: 7, title: "MCP", tabIds: [11] }] });
  w.bg.chrome.tabGroups.onRemoved.fire({ id: 99 }); // someone else's group: nothing changes
  assert.equal(w.session.mcpTabGroupId, 7);
  w.tabs[11].groupId = -1; // the user ungrouped the MCP group
  w.bg.chrome.tabs.onUpdated.fire(11, { groupId: -1 }, w.tabs[11]);
  w.bg.chrome.tabGroups.onRemoved.fire({ id: 7 });
  assert.equal("mcpTabGroupId" in w.session, false);
  assert.equal((await w.bg.handlers.get_page_text({ tabId: 11 })).content[0].text, "Tab 11 is not in the MCP group.");
  assert.equal(listedTabs(await w.bg.handlers.tabs_context_mcp({ createIfEmpty: true })).tabGroupId, 8);
  assert.equal(w.session.mcpTabGroupId, 8);
});

// --- Access follows the tab's live group membership ---

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

const keyEvents = (bg) => bg.calls.filter((c) => c[0] === "cdp" && c[1] === "Input.dispatchKeyEvent").length;
const attaches = (bg) => bg.calls.filter((c) => c[0] === "debugger.attach").length;

async function untilFirstKeyEvent(bg) {
  while (keyEvents(bg) === 0) await flush(2);
}

// The call already passed its group check, so only the release can stop it: its next CDP command
// would otherwise attach the debugger again and go on typing into the tab the user took back.
test("a type call in flight when its tab leaves the group sends no further key event", async () => {
  const bg = await loadBackground();
  const typing = bg.handlers.computer({ action: "type", text: "abcdefghijklmnopqrstuvwxyz", tabId: 11 });
  await untilFirstKeyEvent(bg);
  bg.chrome.tabs.onUpdated.fire(11, { groupId: -1 }, { ...TAB, id: 11, groupId: -1 });
  const sentAtLeave = keyEvents(bg);
  await assert.rejects(typing, /Tab 11 is not in the MCP group/);
  assert.ok(sentAtLeave > 0 && sentAtLeave < 52, `expected the typing to be under way, sent ${sentAtLeave}`);
  assert.equal(keyEvents(bg), sentAtLeave, "no key event after the tab left the group");
  assert.equal(bg.get("attachedTabs").has(11), false);
});

// Another session's tabs_context_mcp can refresh the cache after the tab left but before Chrome's
// groupId event reaches the extension. The release must not depend on the cache still holding it.
test("a tab in flight is released on leaving the group even after another call refreshed the cache", async () => {
  let groupId = 7;
  const bg = await loadBackground({
    overrides: {
      tabs: {
        get: async (id) => ({ ...TAB, id, groupId }),
        query: async ({ groupId: queried } = {}) => (queried === groupId ? [{ ...TAB, id: 11, groupId, title: "t" }] : []),
      },
    },
  });
  const typing = bg.handlers.computer({ action: "type", text: "abcdefghijklmnopqrstuvwxyz", tabId: 11 });
  await untilFirstKeyEvent(bg);
  groupId = -1; // the tab leaves the group
  await bg.handlers.tabs_context_mcp({}); // another call's refresh lands first
  assert.equal(bg.get("tabGroupTabs").has(11), false, "the refresh dropped tab 11 from the cache");
  bg.chrome.tabs.onUpdated.fire(11, { groupId: -1 }, { ...TAB, id: 11, groupId: -1 });
  const sentAtLeave = keyEvents(bg);
  await assert.rejects(typing, /Tab 11 is not in the MCP group/);
  assert.equal(keyEvents(bg), sentAtLeave, "no key event after the tab left the group");
  assert.equal(attaches(bg), 1, "the debugger is not attached again");
  assert.equal(bg.get("attachedTabs").has(11), false);
});

// A group check that read groupId 7 just before the leave event, and finishes after it, must not
// bring the tab back: only Chrome's own report that the tab is back in the group does.
test("a group check answered before the leave event does not bring the released tab back", async () => {
  let gated = false;
  let openGate;
  const gate = new Promise((resolve) => { openGate = resolve; });
  const bg = await loadBackground({
    overrides: { tabs: { get: async (id) => { const tab = { ...TAB, id, groupId: 7 }; if (gated) await gate; return tab; } } },
  });
  await flush();
  gated = true;
  const call = bg.handlers.computer({ action: "screenshot", tabId: 11 });
  await flush();
  bg.chrome.tabs.onUpdated.fire(11, { groupId: -1 }, { ...TAB, id: 11, groupId: -1 });
  openGate();
  const r = await call;
  assert.equal(r.isError, true, JSON.stringify(r));
  assert.equal(r.content[0].text, "Tab 11 is not in the MCP group.");
  assert.equal(bg.get("releasedTabs").has(11), true);
  assert.equal(bg.calls.filter((c) => c[1] === "Page.captureScreenshot").length, 0);
});

test("a released tab that comes back into the group can be used again", async () => {
  let groupId = 7;
  const bg = await loadBackground({ overrides: { tabs: { get: async (id) => ({ ...TAB, id, groupId }) } } });
  await bg.handlers.computer({ action: "screenshot", tabId: 11 });
  groupId = -1;
  bg.chrome.tabs.onUpdated.fire(11, { groupId: -1 }, { ...TAB, id: 11, groupId: -1 });
  assert.equal(bg.get("releasedTabs").has(11), true);
  groupId = 7;
  bg.chrome.tabs.onUpdated.fire(11, { groupId: 7 }, { ...TAB, id: 11, groupId: 7 });
  assert.equal(bg.get("releasedTabs").has(11), false);
  const shot = await bg.handlers.computer({ action: "screenshot", tabId: 11 });
  assert.equal("isError" in shot, false, JSON.stringify(shot));
  assert.equal(attaches(bg), 2, "attached again after coming back");
  assert.equal(bg.get("attachedTabs").has(11), true);
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

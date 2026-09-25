import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBackground } from "./harness/fake-chrome.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// about:blank, not the default New Tab Page: chrome.debugger refuses to attach to a chrome://
// page, and tabs_create_mcp attaches the new tab right away (see dialog.test.mjs).
test("tabs_create_mcp opens the tab in the group's window, on about:blank", async () => {
  const bg = await loadBackground();
  await bg.handlers.tabs_create_mcp({});
  const create = bg.calls.find((c) => c[0] === "tabs.create");
  assert.deepEqual({ ...create[1] }, { windowId: 1, active: true, url: "about:blank" }); // spread: vm-realm objects fail strict deepEqual
});

// Minor 8: when the group's tab closed in the gap since ensureTabGroup last checked (Chrome
// auto-removes a group once its last tab is gone), the query right after used to come back
// empty, and tabs.create fell back to no windowId at all — landing the new tab in the
// operator's own window, then throwing when tabs.group tried to add it to a group that no
// longer existed.
test("tabs_create_mcp retries group creation instead of creating a windowless tab when the group is momentarily empty", async () => {
  let queryCalls = 0;
  const bg = await loadBackground({
    overrides: {
      // Kept empty so the background recoverTabGroupState() call (unrelated to this test) finds
      // no group to adopt and leaves tabGroupId alone, instead of racing the counter below.
      tabGroups: { query: async () => [] },
      tabs: {
        query: async () => {
          queryCalls++;
          return queryCalls === 1 ? [] : [{ id: 11, windowId: 1, groupId: 7, title: "t", url: "https://example.test/" }];
        },
      },
    },
  });
  await bg.handlers.tabs_create_mcp({});
  const create = bg.calls.find((c) => c[0] === "tabs.create");
  assert.deepEqual({ ...create[1] }, { windowId: 1, active: true, url: "about:blank" });
});

test("tabs_create_mcp fails clearly if the MCP group still has no tab after retrying, instead of creating a stray tab", async () => {
  const bg = await loadBackground({ overrides: { tabs: { query: async () => [] } } });
  const r = await bg.handlers.tabs_create_mcp({});
  assert.equal(r.content[0].text, "Could not create or find the MCP tab group.");
  assert.equal(bg.calls.filter((c) => c[0] === "tabs.create").length, 0);
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

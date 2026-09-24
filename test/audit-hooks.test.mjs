// Exercises the background.js wiring: Audit.wrapHandlers around toolHandlers, the
// nativePort -> handleToolRequest -> ctx plumbing, and the audit-prune alarm. The
// real extension/audit/store.js is never loaded here (vm contexts have no
// indexedDB) — beforeRun swaps in an in-memory fake before background.js runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadBackground } from "./harness/fake-chrome.mjs";

const FIXTURE = path.join(import.meta.dirname, "..", "host", "test", "claude-in-chrome-tools.schema.json");
const PREFIX = "mcp__claude-in-chrome__";

const flush = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function makeFakeStore({ failAddAction = false } = {}) {
  const calls = [];
  const sessions = new Map();
  const actions = [];
  return {
    calls,
    sessions,
    actions,
    async open() { calls.push(["open"]); },
    async upsertSession(session, ts) {
      calls.push(["upsertSession", session, ts]);
      const existing = sessions.get(session.id);
      sessions.set(session.id, { ...session, firstSeen: existing ? existing.firstSeen : ts, lastSeen: ts });
    },
    async addAction(action) {
      calls.push(["addAction", action]);
      if (failAddAction) throw new Error("store is full");
      actions.push(action);
    },
    async addEvents(sessionId, tabId, events) {
      calls.push(["addEvents", sessionId, tabId, events]);
    },
    async listSessions() { return [...sessions.values()]; },
    async getSession(id) {
      return { session: sessions.get(id), actions: actions.filter((a) => a.sessionId === id), eventsByTab: {} };
    },
    async deleteSession(id) { sessions.delete(id); },
    async prune(opts) { calls.push(["prune", opts]); },
  };
}

// Filters "audit/store.js" out of importScripts (no indexedDB in a vm context) and
// pre-binds the global AuditStore identifier to the fake before background.js runs.
function injectFakeStore(fakeStore) {
  return (ctx) => {
    const load = ctx.importScripts;
    ctx.importScripts = (...files) => load(...files.filter((f) => f !== "audit/store.js"));
    ctx.AuditStore = fakeStore;
  };
}

const SESSION = { id: "s1", label: "myapp", cwd: "/Users/x/app", pid: 4242 };

// A minimal content-script stand-in so form_input succeeds instead of throwing
// (the default fake has no content script and rejects tabs.sendMessage).
function fakeContent() {
  return { invoke: async () => ({ result: { ok: true } }) };
}

test("wrapping handlers keeps exactly the 22 official tool names as keys", async () => {
  const bg = await loadBackground({ beforeRun: injectFakeStore(makeFakeStore()) });
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  const official = Object.keys(fixture).filter((k) => k.startsWith(PREFIX)).map((k) => k.slice(PREFIX.length)).sort();
  assert.deepEqual(Object.keys(bg.handlers).sort(), official);
});

test("audit disabled by default: a delivered tool request makes no store calls", async () => {
  const fakeStore = makeFakeStore();
  const bg = await loadBackground({ beforeRun: injectFakeStore(fakeStore) });
  await flush(); // let recoverTabGroupState settle before dispatching

  bg.deliver({ type: "tool_request", id: "1.s1.1", tool: "gif_creator", args: {}, session: SESSION });
  await flush();

  assert.deepEqual(fakeStore.calls, []);
  assert.equal(bg.posted.length, 1);
  assert.equal(bg.posted[0].type, "tool_response");
});

test("enabling audit records the session and a redacted action for a delivered tool request", async () => {
  const fakeStore = makeFakeStore();
  const bg = await loadBackground({ content: fakeContent(), beforeRun: injectFakeStore(fakeStore) });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({
    type: "tool_request", id: "1.s1.1", tool: "form_input",
    args: { ref: "ref_1", value: "4111 1111 1111 1111", tabId: bg.tabId },
    session: SESSION,
  });
  await flush();

  assert.equal(fakeStore.sessions.size, 1);
  assert.equal(fakeStore.sessions.get("s1").label, "myapp");
  assert.equal(fakeStore.actions.length, 1);
  const [action] = fakeStore.actions;
  assert.equal(action.sessionId, "s1");
  assert.equal(action.tool, "form_input");
  assert.equal(action.outcome, "ok");
  assert.doesNotMatch(action.summary, /4111/);
  assert.match(action.summary, /^ref_1 value \[\d+ chars\]$/);
});

test("a request without a session is unattributed and records nothing", async () => {
  const fakeStore = makeFakeStore();
  const bg = await loadBackground({ beforeRun: injectFakeStore(fakeStore) });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({ type: "tool_request", id: "1..1", tool: "gif_creator", args: {} }); // no session
  await flush();

  assert.deepEqual(fakeStore.calls, []);
});

test("a handler that throws records an outcome starting with error:, and still returns the error to the host", async () => {
  const fakeStore = makeFakeStore();
  const bg = await loadBackground({ beforeRun: injectFakeStore(fakeStore) }); // no content: sendContentMessage rejects
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({
    type: "tool_request", id: "1.s1.1", tool: "form_input",
    args: { ref: "ref_1", value: "x", tabId: bg.tabId },
    session: SESSION,
  });
  await flush();

  assert.equal(fakeStore.actions.length, 1);
  assert.match(fakeStore.actions[0].outcome, /^error:/);
  assert.equal(bg.posted.length, 1);
  assert.equal(bg.posted[0].type, "tool_error");
  assert.match(bg.posted[0].error, /form_input failed/);
});

test("browser_batch with 2 actions records 3 actions: the batch and its 2 nested calls", async () => {
  const fakeStore = makeFakeStore();
  const bg = await loadBackground({ beforeRun: injectFakeStore(fakeStore) });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({
    type: "tool_request", id: "1.s1.1", tool: "browser_batch",
    args: { actions: [{ name: "gif_creator", input: {} }, { name: "shortcuts_list", input: {} }] },
    session: SESSION,
  });
  await flush();

  assert.equal(fakeStore.actions.length, 3);
  assert.deepEqual(fakeStore.actions.map((a) => a.tool), ["gif_creator", "shortcuts_list", "browser_batch"]);
  assert.match(fakeStore.actions[2].summary, /^batch of 2: gif_creator, shortcuts_list$/);
});

test("a store whose addAction throws does not change the tool result", async () => {
  const fakeStore = makeFakeStore({ failAddAction: true });
  const bg = await loadBackground({ beforeRun: injectFakeStore(fakeStore) });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({ type: "tool_request", id: "1.s1.1", tool: "gif_creator", args: {}, session: SESSION });
  await flush();

  assert.equal(bg.posted.length, 1);
  assert.equal(bg.posted[0].type, "tool_response");
  assert.match(bg.posted[0].result.content[0].text, /GIF recording is not yet implemented/);
});

test("recorder events go to the tab's owning session and are dropped for an unowned tab", async () => {
  const fakeStore = makeFakeStore();
  const bg = await loadBackground({ beforeRun: injectFakeStore(fakeStore) });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  // A tool call with tabId: 42 makes s1 the owner of tab 42.
  bg.deliver({ type: "tool_request", id: "1.s1.1", tool: "gif_creator", args: { tabId: 42 }, session: SESSION });
  await flush();

  bg.chrome.runtime.onMessage.fire({ type: "ocic_audit_events", events: [{ type: 2 }] }, { id: bg.chrome.runtime.id, tab: { id: 42 } }, () => {});
  bg.chrome.runtime.onMessage.fire({ type: "ocic_audit_events", events: [{ type: 2 }] }, { id: bg.chrome.runtime.id, tab: { id: 999 } }, () => {}); // no owner
  await flush();

  const addEventsCalls = fakeStore.calls.filter((c) => c[0] === "addEvents");
  assert.equal(addEventsCalls.length, 1);
  assert.deepEqual(addEventsCalls[0], ["addEvents", "s1", 42, [{ type: 2 }]]);
});

test("recorder events are ignored unless sender.id matches the extension and sender.tab is set", async () => {
  const fakeStore = makeFakeStore();
  const bg = await loadBackground({ beforeRun: injectFakeStore(fakeStore) });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({ type: "tool_request", id: "1.s1.1", tool: "gif_creator", args: { tabId: 42 }, session: SESSION });
  await flush();

  bg.chrome.runtime.onMessage.fire({ type: "ocic_audit_events", events: [{ type: 2 }] }, { id: "some-other-extension", tab: { id: 42 } }, () => {});
  bg.chrome.runtime.onMessage.fire({ type: "ocic_audit_events", events: [{ type: 2 }] }, { id: bg.chrome.runtime.id }, () => {}); // no sender.tab
  await flush();

  assert.deepEqual(fakeStore.calls.filter((c) => c[0] === "addEvents"), []);
});

test("ensureRecorder checks then injects the recorder before and after an audited action with a tabId, only while enabled", async () => {
  const fakeStore = makeFakeStore();
  const bg = await loadBackground({ beforeRun: injectFakeStore(fakeStore) });
  await flush();

  // Disabled: no injection attempts at all.
  bg.deliver({ type: "tool_request", id: "1.s1.1", tool: "gif_creator", args: { tabId: bg.tabId }, session: SESSION });
  await flush();
  assert.deepEqual(bg.calls.filter((c) => c[0] === "scripting.executeScript"), []);

  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });
  bg.deliver({ type: "tool_request", id: "1.s1.2", tool: "gif_creator", args: { tabId: bg.tabId }, session: SESSION });
  await flush();

  // Before and after the action: a presence check, then — since the fake always
  // reports "not present" (scripting.executeScript resolves to []) — an injection of
  // the vendor bundle and recorder.js, each into the same tab's ISOLATED world.
  const injections = bg.calls.filter((c) => c[0] === "scripting.executeScript").map((c) => c[1]);
  assert.equal(injections.length, 4);
  const [check1, inject1, check2, inject2] = injections;
  for (const call of injections) {
    assert.equal(call.target.tabId, bg.tabId);
    assert.equal(call.world, "ISOLATED");
  }
  // Spread into a plain array first: inject*.files was built inside the vm context, so
  // deepEqual against an array literal here would fail on realm identity, not content.
  assert.equal(typeof check1.func, "function");
  assert.deepEqual([...inject1.files], ["vendor/rrweb-record.min.js", "audit/recorder.js"]);
  assert.equal(typeof check2.func, "function");
  assert.deepEqual([...inject2.files], ["vendor/rrweb-record.min.js", "audit/recorder.js"]);
});

test("ensureRecorder swallows a scripting error instead of failing the tool call", async () => {
  const fakeStore = makeFakeStore();
  const bg = await loadBackground({
    beforeRun: injectFakeStore(fakeStore),
    overrides: { scripting: { executeScript: async () => { throw new Error("Cannot access a chrome:// URL"); } } },
  });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({ type: "tool_request", id: "1.s1.1", tool: "gif_creator", args: { tabId: bg.tabId }, session: SESSION });
  await flush();

  assert.equal(bg.posted.length, 1);
  assert.equal(bg.posted[0].type, "tool_response");
});

test("the audit-prune alarm prunes with current settings only while enabled", async () => {
  const fakeStore = makeFakeStore();
  const bg = await loadBackground({ beforeRun: injectFakeStore(fakeStore) });
  await flush();

  // Disabled: firing the alarm must not touch the store.
  bg.chrome.alarms.onAlarm.fire({ name: "audit-prune" });
  await flush();
  assert.deepEqual(fakeStore.calls, []);

  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 3 } });
  bg.chrome.alarms.onAlarm.fire({ name: "audit-prune" });
  await flush();

  const pruneCalls = fakeStore.calls.filter((c) => c[0] === "prune");
  assert.equal(pruneCalls.length, 1);
  assert.equal(pruneCalls[0][1].retentionDays, 3);
  assert.equal(pruneCalls[0][1].maxSessions, 200);
});

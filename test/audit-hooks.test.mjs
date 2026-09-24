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
    async hasSession(id) { return sessions.has(id); },
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

  // I2: the stored session id is "<runId>.<session.id>" (runId = the part of
  // ctx.requestId before the first "."), not the bare hub session id.
  assert.equal(fakeStore.sessions.size, 1);
  assert.equal(fakeStore.sessions.get("1.s1").label, "myapp");
  assert.equal(fakeStore.actions.length, 1);
  const [action] = fakeStore.actions;
  assert.equal(action.sessionId, "1.s1");
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

// M5: a nested `type` inside a browser_batch is dispatched through the same
// wrapped toolHandlers map, so it must be redacted exactly like a top-level one.
test("a nested computer/type call inside a browser_batch is redacted like a top-level one", async () => {
  const fakeStore = makeFakeStore();
  const bg = await loadBackground({ beforeRun: injectFakeStore(fakeStore) });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({
    type: "tool_request", id: "1.s1.1", tool: "browser_batch",
    args: { actions: [{ name: "computer", input: { action: "type", text: "hunter2", tabId: bg.tabId } }] },
    session: SESSION,
  });
  // "type" dispatches one real CDP call (with a 10ms sleep) per character, so
  // the default 0ms flush isn't enough real wall-clock time for it to finish.
  await flush(300);

  const nested = fakeStore.actions.find((a) => a.tool === "computer");
  assert.ok(nested, "expected the nested computer call to be recorded on its own");
  assert.equal(nested.summary, "type [7 chars]");
  assert.doesNotMatch(nested.summary, /hunter2/);
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
  assert.deepEqual(addEventsCalls[0], ["addEvents", "1.s1", 42, [{ type: 2 }]]);
});

// I4: if the owning session's row is gone (pruned, or deleted via a future
// options-page action), a late batch must not resurrect it as an orphan row —
// and the dead mapping should stop being checked on every future batch too.
test("recorder events for a tab whose owning session no longer exists are dropped, and the mapping is forgotten", async () => {
  const fakeStore = makeFakeStore();
  const bg = await loadBackground({ beforeRun: injectFakeStore(fakeStore) });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({ type: "tool_request", id: "1.s1.1", tool: "gif_creator", args: { tabId: 42 }, session: SESSION });
  await flush();
  assert.equal(fakeStore.sessions.size, 1);
  fakeStore.sessions.delete("1.s1"); // simulate the session row having been pruned/deleted

  bg.chrome.runtime.onMessage.fire({ type: "ocic_audit_events", events: [{ type: 2 }] }, { id: bg.chrome.runtime.id, tab: { id: 42 } }, () => {});
  await flush();

  assert.deepEqual(fakeStore.calls.filter((c) => c[0] === "addEvents"), []);
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

// I3: the plan runs prune "on init, and every 60 minutes" with no condition.
// Gating it on `enabled` meant data recorded while audit was briefly on was
// never cleaned up again after the user switched it off. The only thing that
// should skip pruning is never having opted in at all (no "audit" key yet, so
// no database exists to prune and the vm tests without any storage stay quiet).
test("the audit-prune alarm prunes whenever the audit key exists, even after being switched off", async () => {
  const fakeStore = makeFakeStore();
  const bg = await loadBackground({ beforeRun: injectFakeStore(fakeStore) });
  await flush();

  // Never opted in: the "audit" key is absent, so firing the alarm must not
  // touch the store at all (no database before the first opt-in).
  bg.chrome.alarms.onAlarm.fire({ name: "audit-prune" });
  await flush();
  assert.deepEqual(fakeStore.calls, []);

  // Enable, record something, then disable — the key still exists (enabled:
  // false is a stored value, not an absent key).
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 3 } });
  bg.deliver({ type: "tool_request", id: "1.s1.1", tool: "gif_creator", args: {}, session: SESSION });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: false, retentionDays: 3 } });
  fakeStore.calls.length = 0;

  bg.chrome.alarms.onAlarm.fire({ name: "audit-prune" });
  await flush();

  const pruneCalls = fakeStore.calls.filter((c) => c[0] === "prune");
  assert.equal(pruneCalls.length, 1, "prune must still run for data recorded while audit was on, even though it is now off");
  assert.equal(pruneCalls[0][1].retentionDays, 3);
  assert.equal(pruneCalls[0][1].maxSessions, 200);
});

test("Audit.init prunes once immediately when the audit key already exists at load time", async () => {
  const fakeStore = makeFakeStore();
  const bg = await loadBackground({
    beforeRun: injectFakeStore(fakeStore),
    overrides: { storage: { local: { data: { audit: { enabled: true, retentionDays: 5 } } } } },
  });
  await flush();
  const pruneCalls = fakeStore.calls.filter((c) => c[0] === "prune");
  assert.equal(pruneCalls.length, 1);
  assert.equal(pruneCalls[0][1].retentionDays, 5);
});

test("Audit.init registers the audit-prune alarm on a 60-minute period", async () => {
  const bg = await loadBackground({ beforeRun: injectFakeStore(makeFakeStore()) });
  await flush();
  const created = bg.calls.find((c) => c[0] === "alarms.create" && c[1] === "audit-prune");
  assert.ok(created, 'expected chrome.alarms.create("audit-prune", ...) to have been called');
  assert.equal(created[2].periodInMinutes, 60);
});

// M7: a raw <select> value ("7") or a cleared field (undefined) must not
// silently turn off age-based pruning altogether.
test("a non-numeric retentionDays falls back to 7 instead of disabling age pruning", async () => {
  const fakeStore = makeFakeStore();
  const bg = await loadBackground({ beforeRun: injectFakeStore(fakeStore) });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: "not-a-number" } });

  bg.chrome.alarms.onAlarm.fire({ name: "audit-prune" });
  await flush();

  const pruneCalls = fakeStore.calls.filter((c) => c[0] === "prune");
  assert.equal(pruneCalls.length, 1);
  assert.equal(pruneCalls[0][1].retentionDays, 7);
});

// I2: the hub numbers sessions from s1 again in every process, so the bare
// session id alone is not a stable identity across a browser restart.
test("sessions from different hub runs never merge, even when the hub reused the same session id", async () => {
  const fakeStore = makeFakeStore();
  const bg = await loadBackground({ beforeRun: injectFakeStore(fakeStore) });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({ type: "tool_request", id: "runA.s1.1", tool: "gif_creator", args: {}, session: { id: "s1", label: "app", cwd: "/Users/x/app", pid: 100 } });
  await flush();
  bg.deliver({ type: "tool_request", id: "runB.s1.1", tool: "gif_creator", args: {}, session: { id: "s1", label: "other", cwd: "/Users/x/other", pid: 200 } });
  await flush();

  assert.equal(fakeStore.sessions.size, 2);
  assert.equal(fakeStore.sessions.get("runA.s1").label, "app");
  assert.equal(fakeStore.sessions.get("runB.s1").label, "other");
});

// M1: tab ownership used to be set only after recordAction ran (i.e. after the
// whole handler had already returned), so a recorder batch arriving while the
// call was still in flight found no owner yet and was dropped. A gate on
// ensureRecorder's own scripting.executeScript call holds the wrapped handler
// "in flight" realistically (the host is still waiting on it) instead of
// firing the batch in the same synchronous tick as delivery, which would race
// the session's own first-ever upsert (I4's hasSession check) for no reason a
// real recorder — batched every 1s/100 events, well behind a single IndexedDB
// write — would ever actually hit.
test("the tab owner is set before the handler runs, so a batch arriving mid-call is attributed, not dropped", async () => {
  const fakeStore = makeFakeStore();
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  let gated = false;
  const bg = await loadBackground({
    beforeRun: injectFakeStore(fakeStore),
    overrides: { scripting: { executeScript: async () => { if (!gated) { gated = true; await gate; } return []; } } },
  });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({ type: "tool_request", id: "1.s1.1", tool: "gif_creator", args: { tabId: 42 }, session: SESSION });
  await flush(); // tabOwners.set + the early session touch land; ensureRecorder's first executeScript call is now stalled on the gate

  bg.chrome.runtime.onMessage.fire({ type: "ocic_audit_events", events: [{ type: 2 }] }, { id: bg.chrome.runtime.id, tab: { id: 42 } }, () => {});
  await flush();
  releaseGate();
  await flush();

  const addEventsCalls = fakeStore.calls.filter((c) => c[0] === "addEvents");
  assert.equal(addEventsCalls.length, 1, "a batch delivered before the call finished must still be attributed");
  assert.equal(addEventsCalls[0][1], "1.s1");
});

// M2: the audit write must never delay the tool's own response — safeRecord is
// fire-and-forget (it never rejects), so even a store call that never settles
// must not hold up sendResponse.
test("a never-settling store write does not delay the tool result", async () => {
  const fakeStore = makeFakeStore();
  fakeStore.open = () => new Promise(() => {}); // never resolves or rejects
  const bg = await loadBackground({ beforeRun: injectFakeStore(fakeStore) });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({ type: "tool_request", id: "1.s1.1", tool: "gif_creator", args: {}, session: SESSION });
  await flush();

  assert.equal(bg.posted.length, 1);
  assert.equal(bg.posted[0].type, "tool_response");
});

// I1: Chrome's own errors can carry a page URL with its query and fragment
// (e.g. a token in a password-reset link) when the extension can't access a
// tab's content. That must never survive into the stored outcome.
test("a thrown error's outcome is scrubbed of a URL's query and fragment before being stored", async () => {
  const fakeStore = makeFakeStore();
  const chromeErrorMessage = 'Cannot access contents of url "https://bank.test/reset?token=SECRET123#access_token=FRAG456". Extension manifest must request permission to access this host.';
  const bg = await loadBackground({
    beforeRun: injectFakeStore(fakeStore),
    // No content script (default fake): sendContentMessage's first tabs.sendMessage
    // rejects, and its retry through scripting.executeScript throws this exact
    // Chrome permission error, carrying the tab's URL.
    overrides: { scripting: { executeScript: async () => { throw new Error(chromeErrorMessage); } } },
  });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({
    type: "tool_request", id: "1.s1.1", tool: "form_input",
    args: { ref: "ref_1", value: "x", tabId: bg.tabId },
    session: SESSION,
  });
  await flush();

  assert.equal(fakeStore.actions.length, 1);
  const { outcome } = fakeStore.actions[0];
  assert.doesNotMatch(outcome, /SECRET123/);
  assert.doesNotMatch(outcome, /FRAG456/);
  assert.match(outcome, /^error:.*bank\.test\/reset\?…#…/);
});

// M8: audit.js must not leak its internal helpers into the shared worker scope.
test("audit.js exposes only globalThis.Audit, not its internal helpers", async () => {
  const bg = await loadBackground({ beforeRun: injectFakeStore(makeFakeStore()) });
  await flush();
  const leaked = ["settings", "runPrune", "recordAction", "safeRecord", "wrapHandlers", "onRecorderEvents", "ensureRecorder", "sessionKey", "tabOwners"]
    .filter((name) => bg.get(`typeof ${name}`) !== "undefined");
  assert.deepEqual(leaked, []);
});

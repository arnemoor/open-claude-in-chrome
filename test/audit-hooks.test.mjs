// Exercises the background.js wiring: Audit.wrapHandlers around toolHandlers, the
// nativePort -> handleToolRequest -> ctx plumbing, and the audit-prune alarm. The
// real extension/audit/store.js is never loaded here (vm contexts have no
// indexedDB) — beforeRun swaps in an in-memory fake before background.js runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
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

  bg.chrome.runtime.onMessage.fire({ type: "ocic_audit_events", events: [{ type: 2 }] }, { id: bg.chrome.runtime.id, tab: { id: 42 }, frameId: 0 }, () => {});
  bg.chrome.runtime.onMessage.fire({ type: "ocic_audit_events", events: [{ type: 2 }] }, { id: bg.chrome.runtime.id, tab: { id: 999 }, frameId: 0 }, () => {}); // no owner
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

  bg.chrome.runtime.onMessage.fire({ type: "ocic_audit_events", events: [{ type: 2 }] }, { id: bg.chrome.runtime.id, tab: { id: 42 }, frameId: 0 }, () => {});
  // Long enough for the owner-was-set-recently retry (fix round 2, New Minor
  // 2) to fire and find the row still gone, so this assertion reflects the
  // settled outcome, not an in-flight retry.
  await flush(700);

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

// Isolates ensureRecorder's own calls from any other scripting.executeScript call
// a handler might make on its own (e.g. form_input's content-script injection
// retry), which the fake also logs under "scripting.executeScript".
const ensureRecorderCalls = (bg) => bg.calls.filter((c) => c[0] === "scripting.executeScript" && c[1].world === "ISOLATED");

// M4. A custom scripting.executeScript override replaces the fake's method
// entirely (see fake-chrome.mjs's deepAssign), so it must track its own calls
// instead of relying on the fake's usual bg.calls.push.
test("ensureRecorder makes only the presence check when the recorder is already there", async () => {
  const fakeStore = makeFakeStore();
  const executeScriptCalls = [];
  const bg = await loadBackground({
    beforeRun: injectFakeStore(fakeStore),
    overrides: { scripting: { executeScript: async (p) => { executeScriptCalls.push(p); return [{ result: true }]; } } },
  });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({ type: "tool_request", id: "1.s1.1", tool: "gif_creator", args: { tabId: bg.tabId }, session: SESSION });
  await flush();

  assert.equal(executeScriptCalls.length, 2, "before and after: a presence check each time, no injection since the fake always reports 'present'");
  for (const call of executeScriptCalls) assert.equal(call.files, undefined, "a presence check has no files field, only func");
});

// M4
test("ensureRecorder still probes after the handler throws", async () => {
  const fakeStore = makeFakeStore();
  const bg = await loadBackground({ beforeRun: injectFakeStore(fakeStore) }); // no content: form_input's sendContentMessage rejects and its retry throws
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({ type: "tool_request", id: "1.s1.1", tool: "form_input", args: { ref: "ref_1", value: "x", tabId: bg.tabId }, session: SESSION });
  await flush();

  assert.equal(ensureRecorderCalls(bg).length, 4, "before AND after the failed call: a check+inject pair each time");
});

// I4: a page stuck on an open JS dialog (or one that hasn't reached the default
// document_idle injection point) never answers chrome.scripting.executeScript.
// Without a bound, that hangs ensureRecorder, and therefore every audited call
// on that tab, until the host's own request timeout.
test("I4: a never-settling executeScript still gives a prompt tool reply, not an unbounded hang", async () => {
  const fakeStore = makeFakeStore();
  const bg = await loadBackground({
    beforeRun: injectFakeStore(fakeStore),
    overrides: { scripting: { executeScript: async () => new Promise(() => {}) } },
  });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({ type: "tool_request", id: "1.s1.1", tool: "gif_creator", args: { tabId: bg.tabId }, session: SESSION });
  await flush(600); // comfortably more than the ~300ms probe bound, nowhere near "hangs forever"

  assert.equal(bg.posted.length, 1, "expected a prompt reply despite the stuck renderer");
  assert.equal(bg.posted[0].type, "tool_response");
});

// I5 (plan-mandated): a tabId the tool itself would refuse (outside the MCP
// group) must not get a recorder or become that tab's owner. gif_creator has no
// group check of its own — the review's own example of a stub that injected
// regardless — so the gate has to come from audit.js, not from the handler.
test("I5: a tab outside the MCP group gets no recorder, and its later recorder batches are not stored", async () => {
  const fakeStore = makeFakeStore();
  const OUTSIDE_TAB = 999;
  const bg = await loadBackground({
    beforeRun: injectFakeStore(fakeStore),
    overrides: { tabs: { get: async (id) => ({ id, windowId: 1, status: "complete", url: "https://example.test/", groupId: id === OUTSIDE_TAB ? -1 : 7 }) } },
  });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({ type: "tool_request", id: "1.s1.1", tool: "gif_creator", args: { tabId: OUTSIDE_TAB }, session: SESSION });
  await flush();

  assert.deepEqual(ensureRecorderCalls(bg), []);

  bg.chrome.runtime.onMessage.fire({ type: "ocic_audit_events", events: [{ type: 2 }] }, { id: bg.chrome.runtime.id, tab: { id: OUTSIDE_TAB }, frameId: 0 }, () => {});
  await flush();
  assert.deepEqual(fakeStore.calls.filter((c) => c[0] === "addEvents"), []);
});

// I5: a tab inside the group is unaffected by the new gate.
test("I5: a tab inside the MCP group still gets a recorder", async () => {
  const fakeStore = makeFakeStore();
  const bg = await loadBackground({ beforeRun: injectFakeStore(fakeStore) });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({ type: "tool_request", id: "1.s1.1", tool: "gif_creator", args: { tabId: bg.tabId }, session: SESSION });
  await flush();

  assert.equal(ensureRecorderCalls(bg).length, 4);
});

// Item 9: a tab's recorder keeps running (and keeps sending batches) after the
// tab leaves the MCP group — nothing tells the content script to stop. Those
// batches must stop being stored the moment isTabAllowed(tabId) goes false,
// and the stale owner must be cleared, not just gated: if the tab later
// rejoins the group with no new audited call re-establishing ownership, a
// batch for it must still be dropped, not resumed under the old owner.
test("item 9: recorder events stop and the owner is cleared once a tab leaves the MCP group", async () => {
  const fakeStore = makeFakeStore();
  let insideGroup = true;
  const bg = await loadBackground({
    beforeRun: injectFakeStore(fakeStore),
    overrides: { tabs: { get: async (id) => ({ id, windowId: 1, status: "complete", url: "https://example.test/", groupId: insideGroup ? 7 : -1 }) } },
  });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({ type: "tool_request", id: "1.s1.1", tool: "gif_creator", args: { tabId: 42 }, session: SESSION });
  await flush();

  bg.chrome.runtime.onMessage.fire({ type: "ocic_audit_events", events: [{ type: 2 }] }, { id: bg.chrome.runtime.id, tab: { id: 42 }, frameId: 0 }, () => {});
  await flush();
  assert.equal(fakeStore.calls.filter((c) => c[0] === "addEvents").length, 1, "still inside the group: the batch is stored");

  insideGroup = false; // the tab leaves the MCP group (dragged out, ungrouped), no new tool call
  bg.chrome.runtime.onMessage.fire({ type: "ocic_audit_events", events: [{ type: 2 }] }, { id: bg.chrome.runtime.id, tab: { id: 42 }, frameId: 0 }, () => {});
  await flush();
  assert.equal(fakeStore.calls.filter((c) => c[0] === "addEvents").length, 1, "left the group: the next batch must be dropped");

  insideGroup = true; // the tab rejoins, but nothing has re-established ownership
  bg.chrome.runtime.onMessage.fire({ type: "ocic_audit_events", events: [{ type: 2 }] }, { id: bg.chrome.runtime.id, tab: { id: 42 }, frameId: 0 }, () => {});
  await flush();
  assert.equal(fakeStore.calls.filter((c) => c[0] === "addEvents").length, 1, "the owner was cleared on leaving, so rejoining alone must not resume storing under the old owner");
});

// Item 16: a chrome:// page, the Web Store, or any other page that refuses
// injection makes ensureRecorder pay its full probe (up to 300ms) plus inject
// (up to 2s) timeout budget on every audited call to that tab, before and
// after — every call, for as long as the tab stays on that document.
// Remembers a failed start per (tabId, url) and skips both attempts until a
// navigation, so the cost is paid once per document, not once per call.
test("item 16: a failed recorder start is remembered per tab+url and skipped until navigation", async () => {
  const fakeStore = makeFakeStore();
  let executeScriptCalls = 0;
  const bg = await loadBackground({
    beforeRun: injectFakeStore(fakeStore),
    overrides: { scripting: { executeScript: async () => { executeScriptCalls++; throw new Error("Cannot access a chrome:// URL"); } } },
  });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({ type: "tool_request", id: "1.s1.1", tool: "gif_creator", args: { tabId: bg.tabId }, session: SESSION });
  await flush();
  const afterFirstCall = executeScriptCalls;
  assert.ok(afterFirstCall > 0, "expected at least one probe attempt on the first call");

  bg.deliver({ type: "tool_request", id: "1.s1.2", tool: "gif_creator", args: { tabId: bg.tabId }, session: SESSION });
  await flush();
  assert.equal(executeScriptCalls, afterFirstCall, "a second call on the same document must make no executeScript call at all");

  bg.chrome.tabs.onUpdated.fire(bg.tabId, { status: "loading" }, {});
  bg.deliver({ type: "tool_request", id: "1.s1.3", tool: "gif_creator", args: { tabId: bg.tabId }, session: SESSION });
  await flush();
  assert.ok(executeScriptCalls > afterFirstCall, "a navigation must re-enable the probe/inject attempt");

  // The tool call itself must still succeed despite the recorder never starting.
  assert.equal(bg.posted.filter((p) => p.type === "tool_response").length, 3);
});

// A probe times out on a busy page, or on one not yet at document_idle, and
// the page's "loading" and URL updates have already fired by then. Remembering
// that failure would leave the document without a recorder for good.
test("a probe timeout is not remembered: the next call probes and injects again", async () => {
  const fakeStore = makeFakeStore();
  let pageReady = false;
  let probes = 0;
  let injects = 0;
  const bg = await loadBackground({
    beforeRun: injectFakeStore(fakeStore),
    overrides: { scripting: { executeScript: async (p) => {
      if (p.files) { injects++; return []; }
      probes++;
      if (!pageReady) return new Promise(() => {}); // never answers, like a page stuck in a long task
      return [{ result: false }];
    } } },
  });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({ type: "tool_request", id: "1.s1.1", tool: "gif_creator", args: { tabId: bg.tabId }, session: SESSION });
  await flush(800); // the before- and after-hook probes both time out (300ms each)
  assert.equal(injects, 0);
  const probesAfterTimeouts = probes;

  pageReady = true; // no onUpdated event: the page just finished its long task
  bg.deliver({ type: "tool_request", id: "1.s1.2", tool: "gif_creator", args: { tabId: bg.tabId }, session: SESSION });
  await flush(100);
  assert.ok(probes > probesAfterTimeouts, "the next call must probe again");
  assert.ok(injects > 0, "and inject the recorder, since the probe found none");
});

test("a transient executeScript rejection is not remembered either", async () => {
  const fakeStore = makeFakeStore();
  let failures = 1;
  let injects = 0;
  const bg = await loadBackground({
    beforeRun: injectFakeStore(fakeStore),
    overrides: { scripting: { executeScript: async (p) => {
      if (failures > 0) { failures--; throw new Error("Frame with ID 0 was removed."); }
      if (p.files) { injects++; return []; }
      return [{ result: false }];
    } } },
  });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({ type: "tool_request", id: "1.s1.1", tool: "gif_creator", args: { tabId: bg.tabId }, session: SESSION });
  await flush(100);
  assert.ok(injects > 0, "the after-hook must try again after a transient rejection in the before-hook");
});

// A new owner's stream needs its own FullSnapshot to replay from. The probe's
// func is rebuilt from its source in a separate context, the way Chrome
// serializes it into the page, so it can use nothing from audit.js's scope.
test("a tab whose owner changes asks its running recorder for a full snapshot", async () => {
  const fakeStore = makeFakeStore();
  const world = vm.createContext({});
  vm.runInContext(`globalThis.snapshots = 0; globalThis[Symbol.for("ocic.audit.recorder")] = { takeFullSnapshot() { globalThis.snapshots++; } };`, world);
  const bg = await loadBackground({
    beforeRun: injectFakeStore(fakeStore),
    overrides: { scripting: { executeScript: async (p) => {
      if (p.files) return [];
      const func = vm.runInContext(`(${p.func.toString()})`, world);
      return [{ result: func(...(p.args || [])) }];
    } } },
  });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });
  const snapshots = () => vm.runInContext("globalThis.snapshots", world);
  const call = async (id, session) => {
    bg.deliver({ type: "tool_request", id, tool: "gif_creator", args: { tabId: 42 }, session });
    await flush();
  };

  await call("1.s1.1", SESSION); // no owner yet: s1's stream starts here
  assert.equal(snapshots(), 1);
  await call("1.s1.2", SESSION); // same owner: its stream already has a snapshot
  assert.equal(snapshots(), 1);
  await call("1.s2.1", { id: "s2", label: "other", cwd: "/Users/x/other", pid: 4343 }); // another session takes over
  assert.equal(snapshots(), 2);
  await call("2.s1.1", SESSION); // the same hub session id after a hub restart is a new owner too
  assert.equal(snapshots(), 3);
});

// M1: `started` used to be captured after the before-hook but `ms` was computed
// after the after-hook too, so a slow ensureRecorder call (a large page's full
// snapshot, or now I4's own timeout budget) inflated the recorded duration of
// completely unrelated actions such as navigate.
test("M1: the recorded duration does not include the (unawaited) after-hook's own executeScript time", async () => {
  const fakeStore = makeFakeStore();
  const bg = await loadBackground({
    beforeRun: injectFakeStore(fakeStore),
    // Well under I4's 300ms probe timeout, so this test is only about M1's
    // ordering, not I4's timeout race.
    overrides: { scripting: { executeScript: async () => { await new Promise((r) => setTimeout(r, 200)); return []; } } },
  });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({ type: "tool_request", id: "1.s1.1", tool: "gif_creator", args: { tabId: bg.tabId }, session: SESSION });
  await flush(700); // long enough for both the awaited before-hook and the unawaited after-hook to actually finish in the background

  assert.equal(fakeStore.actions.length, 1);
  assert.ok(fakeStore.actions[0].ms < 100, `expected ms well under the 200ms executeScript delay, got ${fakeStore.actions[0].ms}`);
});

// M6: sender.id is always the extension's own for anything reaching onMessage
// (no externally_connectable), so it alone is a weak gate. frameId must be the
// top frame (injection always targets frame 0), and origin must not be the
// extension's own pages (e.g. Task 17's options.html opened in a tab), which
// also pass the sender.id/sender.tab checks.
test("M6: recorder events are ignored unless sender.frameId is 0 and sender.origin is not the extension's own", async () => {
  const fakeStore = makeFakeStore();
  const bg = await loadBackground({ beforeRun: injectFakeStore(fakeStore) });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({ type: "tool_request", id: "1.s1.1", tool: "gif_creator", args: { tabId: 42 }, session: SESSION });
  await flush();

  const extensionOrigin = `chrome-extension://${bg.chrome.runtime.id}`;
  bg.chrome.runtime.onMessage.fire({ type: "ocic_audit_events", events: [{ type: 2 }] }, { id: bg.chrome.runtime.id, tab: { id: 42 }, frameId: 1, origin: "https://example.test" }, () => {}); // sub-frame
  bg.chrome.runtime.onMessage.fire({ type: "ocic_audit_events", events: [{ type: 2 }] }, { id: bg.chrome.runtime.id, tab: { id: 42 }, frameId: 0, origin: extensionOrigin }, () => {}); // the extension's own page
  await flush();

  assert.deepEqual(fakeStore.calls.filter((c) => c[0] === "addEvents"), []);
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

  bg.chrome.runtime.onMessage.fire({ type: "ocic_audit_events", events: [{ type: 2 }] }, { id: bg.chrome.runtime.id, tab: { id: 42 }, frameId: 0 }, () => {});
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

// A refusal or failure comes back as a result with isError, not as a throw, and
// must still be recorded as an error, with its text scrubbed like a thrown one.
test("a refused call is recorded with outcome error: and its text", async () => {
  const fakeStore = makeFakeStore();
  const bg = await loadBackground({
    beforeRun: injectFakeStore(fakeStore),
    overrides: { tabs: { get: async (id) => ({ id, windowId: 1, status: "complete", url: "https://example.test/", groupId: 8 }) } },
  });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({ type: "tool_request", id: "1.s1.1", tool: "get_page_text", args: { tabId: 99 }, session: SESSION });
  await flush();

  assert.equal(fakeStore.actions.length, 1);
  assert.equal(fakeStore.actions[0].outcome, "error: Tab 99 is not in the MCP group.");
  assert.equal(bg.posted[0].type, "tool_response");
  assert.equal(bg.posted[0].result.isError, true);
});

test("an error result's outcome is scrubbed of a URL's query and fragment", async () => {
  const fakeStore = makeFakeStore();
  const bg = await loadBackground({
    beforeRun: injectFakeStore(fakeStore),
    overrides: { tabs: { update: async () => { throw new Error("boom"); } } },
  });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({ type: "tool_request", id: "1.s1.1", tool: "navigate", args: { url: "https://x.test/reset?token=SECRET#frag", tabId: bg.tabId }, session: SESSION });
  await flush(100);

  assert.equal(fakeStore.actions.length, 1);
  const { outcome } = fakeStore.actions[0];
  assert.doesNotMatch(outcome, /SECRET|frag/);
  assert.match(outcome, /^error: Could not navigate to https:\/\/x\.test\/reset\?…#…/);
});

test("a batch that stops on an error result is recorded as an error, and so is the failed action, and the rest is not run", async () => {
  const fakeStore = makeFakeStore();
  const content = { invoke: async (msg) => (msg.type === "setFormValue" ? { result: { error: "Element ref_99 not found or was garbage collected." } } : { result: [] }) };
  const bg = await loadBackground({ content, beforeRun: injectFakeStore(fakeStore) });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({
    type: "tool_request", id: "1.s1.1", tool: "browser_batch",
    args: { actions: [
      { name: "computer", input: { action: "screenshot", tabId: bg.tabId } },
      { name: "form_input", input: { ref: "ref_99", value: "100", tabId: bg.tabId } },
      { name: "computer", input: { action: "key", text: "Enter", tabId: bg.tabId } },
    ] },
    session: SESSION,
  });
  await flush(300);

  assert.deepEqual(fakeStore.actions.map((a) => [a.tool, a.outcome]), [
    ["computer", "ok"],
    ["form_input", "error: Error: Element ref_99 not found or was garbage collected."],
    ["browser_batch", "error: Action 2 (form_input) failed, so the batch stopped."],
  ]);
});

// M8: audit.js must not leak its internal helpers into the shared worker scope.
test("audit.js exposes only globalThis.Audit, not its internal helpers", async () => {
  const bg = await loadBackground({ beforeRun: injectFakeStore(makeFakeStore()) });
  await flush();
  const leaked = ["settings", "runPrune", "recordAction", "safeRecord", "wrapHandlers", "onRecorderEvents", "ensureRecorder", "sessionKey", "tabOwners"]
    .filter((name) => bg.get(`typeof ${name}`) !== "undefined");
  assert.deepEqual(leaked, []);
});

// Fix round 2, T16 I1+I2 (partial): nothing pinned redactEvents' own wiring
// into onRecorderEvents — a mutation run removing that call left every
// existing hooks test green. This sends a hand-built batch (a raw hidden-input
// value, a cleared password's raw value attribute, a Meta href with a query
// and fragment, and a URL attribute with a query) straight through
// onMessage.fire, the same path a real recorder's batch takes, and asserts on
// what the fake store actually received.
test("recorder events are redacted (hidden value, cleared value, Meta href, URL attribute) before being stored", async () => {
  const fakeStore = makeFakeStore();
  const bg = await loadBackground({ beforeRun: injectFakeStore(fakeStore) });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({ type: "tool_request", id: "1.s1.1", tool: "gif_creator", args: { tabId: 42 }, session: SESSION });
  await flush();

  const rawEvents = [
    { type: 4, data: { href: "http://x.test/a?token=SECRETQ#access_token=SECRETF" } },
    {
      type: 2,
      data: {
        node: {
          type: 0, id: 1, childNodes: [
            { type: 2, tagName: "input", attributes: { type: "hidden", value: "HIDDENRAW1" }, id: 2, childNodes: [] },
            { type: 2, tagName: "input", attributes: { type: "password", value: "CLEAREDRAW2" }, id: 3, childNodes: [] },
            { type: 2, tagName: "a", attributes: { href: "https://x.test/reset?token=abc" }, id: 4, childNodes: [] },
          ],
        },
      },
    },
  ];
  bg.chrome.runtime.onMessage.fire({ type: "ocic_audit_events", events: rawEvents }, { id: bg.chrome.runtime.id, tab: { id: 42 }, frameId: 0 }, () => {});
  await flush();

  const addEventsCall = fakeStore.calls.find((c) => c[0] === "addEvents");
  assert.ok(addEventsCall, "expected addEvents to be called");
  const storedJson = JSON.stringify(addEventsCall[3]);
  assert.doesNotMatch(storedJson, /HIDDENRAW1/);
  assert.doesNotMatch(storedJson, /CLEAREDRAW2/);
  assert.doesNotMatch(storedJson, /SECRETQ|SECRETF/);
  assert.doesNotMatch(storedJson, /token=abc/);
});

// New Minor 2 (fix round 2): the owner is set synchronously, but touchSession
// writes the session row asynchronously — a batch landing in that narrow
// window used to fail hasSession, get dropped, and delete the tab's owner, so
// every later batch for that tab (including a new document's full snapshot
// after a navigate) was dropped too. Retrying once, half a second later,
// closes that window for any owner set in roughly the last 10s.
test("a recorder batch that arrives before the session row is written is retried once, not dropped", async () => {
  const fakeStore = makeFakeStore();
  let hasSessionCalls = 0;
  fakeStore.hasSession = async () => {
    hasSessionCalls++;
    return hasSessionCalls > 1; // false the first time (row not written yet), true after
  };
  const bg = await loadBackground({ beforeRun: injectFakeStore(fakeStore) });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({ type: "tool_request", id: "1.s1.1", tool: "gif_creator", args: { tabId: 42 }, session: SESSION });
  await flush(); // owner set

  bg.chrome.runtime.onMessage.fire({ type: "ocic_audit_events", events: [{ type: 2 }] }, { id: bg.chrome.runtime.id, tab: { id: 42 }, frameId: 0 }, () => {});
  await flush(700); // long enough for the ~500ms retry to actually elapse

  assert.ok(hasSessionCalls >= 2, "expected a retry, not just one hasSession check");
  const addEventsCalls = fakeStore.calls.filter((c) => c[0] === "addEvents");
  assert.equal(addEventsCalls.length, 1, "expected the batch to be stored once the retry found the row");
});

// Fix round 3, item 6 (test gap, pulled): the retry test above only proves a
// retry happens well inside the window (a bare flush() after delivering the
// tool_request) — it says nothing about the window's upper bound. "Always
// retry once, regardless of age" would pass that test identically. This
// waits past RECENT_OWNER_WINDOW_MS (10s) before the batch ever arrives, so
// hasSessionWithRetry must see the owner as stale and skip the retry outright
// — the row really is gone (pruned, or deleted from the options page), not
// just delayed.
test("a recorder batch arriving more than 10s after the owner was set is dropped without a retry", async () => {
  const fakeStore = makeFakeStore();
  let hasSessionCalls = 0;
  fakeStore.hasSession = async () => { hasSessionCalls++; return false; }; // the row is genuinely gone, not just delayed
  const bg = await loadBackground({ beforeRun: injectFakeStore(fakeStore) });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({ type: "tool_request", id: "1.s1.1", tool: "gif_creator", args: { tabId: 42 }, session: SESSION });
  await flush(); // owner set

  await flush(10200); // comfortably past the 10s window, before the batch below ever arrives

  bg.chrome.runtime.onMessage.fire({ type: "ocic_audit_events", events: [{ type: 2 }] }, { id: bg.chrome.runtime.id, tab: { id: 42 }, frameId: 0 }, () => {});
  await flush(700); // long enough for a (wrongly-taken) ~500ms retry to actually elapse

  assert.equal(hasSessionCalls, 1, "a stale (>10s) owner must not get the 500ms retry at all");
  assert.deepEqual(fakeStore.calls.filter((c) => c[0] === "addEvents"), []);
});

// New Minor 3 (fix round 2): tabOwners and the walker's per-tab tag map were
// never cleared when a tab closed, growing unboundedly (the tag map holds one
// entry per element — tens of thousands on a large page) for as long as the
// worker stays alive.
test("the tab owner is forgotten when the tab closes, so a later batch for it is dropped", async () => {
  const fakeStore = makeFakeStore();
  const bg = await loadBackground({ beforeRun: injectFakeStore(fakeStore) });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({ type: "tool_request", id: "1.s1.1", tool: "gif_creator", args: { tabId: 42 }, session: SESSION });
  await flush();

  bg.chrome.tabs.onRemoved.fire(42);
  await flush();

  bg.chrome.runtime.onMessage.fire({ type: "ocic_audit_events", events: [{ type: 2 }] }, { id: bg.chrome.runtime.id, tab: { id: 42 }, frameId: 0 }, () => {});
  await flush();

  assert.deepEqual(fakeStore.calls.filter((c) => c[0] === "addEvents"), []);
});

// Fix round 3, item 6 (test gap, pulled): the test above only proves
// tabOwners is forgotten — onRecorderEvents already returns early with no
// owner, before it ever touches knownTagsByTab, so that alone says nothing
// about whether the tag map itself is cleared. A closed tab's id is routinely
// reused by a fresh document (rrweb's node ids restart from 1 there), so a
// surviving id->tagName entry is not just useless but actively wrong: the
// same numeric id could now be a password input instead of the option it
// used to be. This re-establishes ownership on the same tabId after the
// close (a fresh document's first tool call would do the same) and sends a
// mutation on the old id with deliberately no new full snapshot in between —
// a full snapshot would reset knownTags on its own and prove nothing here.
test("chrome.tabs.onRemoved clears the tab's known-tags map too, not just its owner", async () => {
  const fakeStore = makeFakeStore();
  const bg = await loadBackground({ beforeRun: injectFakeStore(fakeStore) });
  await flush();
  await bg.chrome.storage.local.set({ audit: { enabled: true, retentionDays: 7 } });

  bg.deliver({ type: "tool_request", id: "1.s1.1", tool: "gif_creator", args: { tabId: 42 }, session: SESSION });
  await flush();

  const snapshot = [{
    type: 2,
    data: { node: { type: 0, id: 1, childNodes: [{ type: 2, tagName: "option", attributes: { value: "US" }, id: 9, childNodes: [] }] } },
  }];
  bg.chrome.runtime.onMessage.fire({ type: "ocic_audit_events", events: snapshot }, { id: bg.chrome.runtime.id, tab: { id: 42 }, frameId: 0 }, () => {});
  await flush();

  bg.chrome.tabs.onRemoved.fire(42);
  await flush();

  // Same tab id, reused by a fresh document: re-establish ownership like that
  // document's first tool call would, but send no new full snapshot — id 9
  // is only reachable as "option" if a stale map entry survived the close.
  bg.deliver({ type: "tool_request", id: "1.s1.2", tool: "gif_creator", args: { tabId: 42 }, session: SESSION });
  await flush();

  const mutation = [{ type: 3, data: { source: 0, texts: [], removes: [], adds: [], attributes: [{ id: 9, attributes: { value: "FRESHDOC9SECRET" } }] } }];
  bg.chrome.runtime.onMessage.fire({ type: "ocic_audit_events", events: mutation }, { id: bg.chrome.runtime.id, tab: { id: 42 }, frameId: 0 }, () => {});
  await flush();

  const addEventsCalls = fakeStore.calls.filter((c) => c[0] === "addEvents");
  const lastStored = JSON.stringify(addEventsCalls[addEventsCalls.length - 1][3]);
  assert.doesNotMatch(lastStored, /FRESHDOC9SECRET/, "id 9's stale \"option\" tag must not survive the tab close");
});

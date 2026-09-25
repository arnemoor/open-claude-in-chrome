// Exercises extension/audit/store.js (globalThis.AuditStore) against real IndexedDB.
// IndexedDB needs a real origin, not a data: URL (opaque origins throw on
// indexedDB.open), so each test serves its page from a fresh local HTTP server on
// 127.0.0.1 and closes it afterward, giving every test its own isolated database.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromeAvailable, launchChrome, openPage } from "./harness/browser.mjs";

const STORE_JS = fs.readFileSync(path.join(import.meta.dirname, "..", "extension", "audit", "store.js"), "utf8");

let browser;
before(async () => { if (chromeAvailable) browser = await launchChrome(); }, { timeout: 30000 });
after(() => browser?.close());

// Opens a fresh page (on its own http origin, so a fresh IndexedDB) with store.js
// loaded and AuditStore.open()'d, runs `fn(page)`, then tears the server down.
async function withStore(fn) {
  const server = http.createServer((req, res) => { res.end("<!doctype html><title>audit-store test</title>"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const page = await openPage(browser, { url: `http://127.0.0.1:${port}/` });
    await page.evaluate(STORE_JS);
    await page.evaluate("AuditStore.open()");
    await fn(page);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const call = (page, expr) => page.evaluate(expr);
const upsert = (page, session, ts) => call(page, `AuditStore.upsertSession(${JSON.stringify(session)}, ${ts})`);
const addAction = (page, action) => call(page, `AuditStore.addAction(${JSON.stringify(action)})`);
const addEvents = (page, sessionId, tabId, events) => call(page, `AuditStore.addEvents(${JSON.stringify(sessionId)}, ${tabId}, ${JSON.stringify(events)})`);
const getSession = (page, id) => call(page, `AuditStore.getSession(${JSON.stringify(id)})`);
const listSessions = (page) => call(page, "AuditStore.listSessions()");
const deleteSession = (page, id) => call(page, `AuditStore.deleteSession(${JSON.stringify(id)})`);
const prune = (page, opts) => call(page, `AuditStore.prune(${JSON.stringify(opts)})`);
const hasSession = (page, id) => call(page, `AuditStore.hasSession(${JSON.stringify(id)})`);
const listSessionSummaries = (page) => call(page, "AuditStore.listSessionSummaries()");

test("upsertSession twice keeps one row and updates lastSeen", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withStore(async (page) => {
    await upsert(page, { id: "s1", label: "app", cwd: "/x", pid: 1 }, 1000);
    await upsert(page, { id: "s1", label: "app", cwd: "/x", pid: 1 }, 2000);
    const sessions = await listSessions(page);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, "s1");
    assert.equal(sessions[0].lastSeen, 2000);
  });
});

test("getSession returns all actions and events grouped by tab", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withStore(async (page) => {
    await upsert(page, { id: "s1", label: "app", cwd: "/x", pid: 1 }, 1000);
    await addAction(page, { sessionId: "s1", ts: 1001, tool: "navigate", tabId: 11, summary: "https://x.test/", outcome: "ok", ms: 5 });
    await addAction(page, { sessionId: "s1", ts: 1002, tool: "computer", tabId: 11, summary: "left_click at (1, 2)", outcome: "ok", ms: 5 });
    await addAction(page, { sessionId: "s1", ts: 1003, tool: "computer", tabId: 12, summary: "left_click at (3, 4)", outcome: "ok", ms: 5 });
    await addEvents(page, "s1", 11, [{ type: 2, data: {} }]);
    await addEvents(page, "s1", 12, [{ type: 2, data: {} }, { type: 3, data: {} }]);

    const { session, actions, eventsByTab } = await getSession(page, "s1");
    assert.equal(session.id, "s1");
    assert.equal(actions.length, 3);
    assert.equal(Object.keys(eventsByTab).length, 2);
    assert.equal(eventsByTab[11].length, 1);
    assert.equal(eventsByTab[12].length, 2);
  });
});

test("deleteSession removes the session, its actions and its events", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withStore(async (page) => {
    await upsert(page, { id: "s1", label: "app", cwd: "/x", pid: 1 }, 1000);
    await addAction(page, { sessionId: "s1", ts: 1001, tool: "navigate", tabId: 11, summary: "x", outcome: "ok", ms: 1 });
    await addEvents(page, "s1", 11, [{ type: 2, data: {} }]);

    await deleteSession(page, "s1");

    const sessions = await listSessions(page);
    assert.equal(sessions.length, 0);
    const { session, actions, eventsByTab } = await getSession(page, "s1");
    assert.equal(session, undefined);
    assert.equal(actions.length, 0);
    assert.equal(Object.keys(eventsByTab).length, 0);
  });
});

test("listSessions returns newest first", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withStore(async (page) => {
    await upsert(page, { id: "old", label: "a", cwd: "/a", pid: 1 }, 1000);
    await upsert(page, { id: "new", label: "b", cwd: "/b", pid: 2 }, 5000);
    const sessions = await listSessions(page);
    assert.deepEqual(sessions.map((s) => s.id), ["new", "old"]);
  });
});

test("prune deletes sessions older than retentionDays, and their actions/events", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withStore(async (page) => {
    const dayMs = 24 * 60 * 60 * 1000;
    const start = 10_000_000;
    await upsert(page, { id: "s1", label: "app", cwd: "/x", pid: 1 }, start);
    await addAction(page, { sessionId: "s1", ts: start, tool: "navigate", tabId: 1, summary: "x", outcome: "ok", ms: 1 });

    await prune(page, { retentionDays: 7, maxSessions: 200, now: start + 8 * dayMs });

    const sessions = await listSessions(page);
    assert.equal(sessions.length, 0);
    const { actions } = await getSession(page, "s1");
    assert.equal(actions.length, 0);
  });
});

test("prune with maxSessions keeps only the newest sessions", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withStore(async (page) => {
    await upsert(page, { id: "s1", label: "a", cwd: "/a", pid: 1 }, 1000);
    await upsert(page, { id: "s2", label: "b", cwd: "/b", pid: 2 }, 2000);
    await upsert(page, { id: "s3", label: "c", cwd: "/c", pid: 3 }, 3000);

    await prune(page, { maxSessions: 1, now: 3000 });

    const sessions = await listSessions(page);
    assert.deepEqual(sessions.map((s) => s.id), ["s3"]);
  });
});

// I4: prune previously only ever looked at a session's own lastSeen, so a
// long-running session (still "active", lastSeen recent) kept every action and
// event it had ever produced, however old — they never aged out on their own.
test("prune deletes old actions and events by their own ts, even under a session that is still active", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withStore(async (page) => {
    const dayMs = 24 * 60 * 60 * 1000;
    // Anchor everything to a vantage point far in the future relative to the
    // real wall clock: addEvents stamps its row with the real Date.now() (its
    // signature takes no ts), so pruning "as of" a point 100 days from now
    // makes that real-time event row unambiguously "old" without depending on
    // exactly when this test happens to run.
    const pruneNow = Date.now() + 100 * dayMs;
    await upsert(page, { id: "s1", label: "app", cwd: "/x", pid: 1 }, pruneNow); // lastSeen == the vantage point: still "active"
    await addAction(page, { sessionId: "s1", ts: pruneNow - 10 * dayMs, tool: "navigate", tabId: 1, summary: "old", outcome: "ok", ms: 1 });
    await addAction(page, { sessionId: "s1", ts: pruneNow - 1 * dayMs, tool: "navigate", tabId: 1, summary: "recent", outcome: "ok", ms: 1 });
    await addEvents(page, "s1", 1, [{ type: 2, data: { tag: "should-be-pruned" } }]);

    await prune(page, { retentionDays: 7, maxSessions: 200, now: pruneNow });

    const sessions = await listSessions(page);
    assert.equal(sessions.length, 1, "the session itself is still active (lastSeen == the vantage point) and must survive");
    const { actions, eventsByTab } = await getSession(page, "s1");
    assert.deepEqual(actions.map((a) => a.summary), ["recent"]);
    assert.equal(Object.keys(eventsByTab).length, 0, "the event row (real-time ts, ~100 days before the vantage point) must be pruned");
  });
});

// Important 1: options.js's sessions table must not load every session's full
// recording (tens of MB of rrweb events each) just to show an action count and
// a tab count. listSessionSummaries gets both without ever touching the
// "events" store's own event payloads: the action count from the actions
// store's sessionId index, the tab count from tab ids kept on the session row.
test("listSessionSummaries reports action and tab counts per session, newest first, without loading events", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withStore(async (page) => {
    await upsert(page, { id: "old", label: "a", cwd: "/a", pid: 1 }, 1000);
    await addAction(page, { sessionId: "old", ts: 1001, tool: "navigate", tabId: 1, summary: "x", outcome: "ok", ms: 1 });

    await upsert(page, { id: "new", label: "b", cwd: "/b", pid: 2 }, 5000);
    await addAction(page, { sessionId: "new", ts: 5001, tool: "navigate", tabId: 11, summary: "x", outcome: "ok", ms: 1 });
    await addAction(page, { sessionId: "new", ts: 5002, tool: "computer", tabId: 11, summary: "y", outcome: "ok", ms: 1 });
    await addAction(page, { sessionId: "new", ts: 5003, tool: "computer", tabId: 12, summary: "z", outcome: "ok", ms: 1 });
    await addEvents(page, "new", 11, [{ type: 2, data: {} }]);
    await addEvents(page, "new", 12, [{ type: 2, data: {} }, { type: 3, data: {} }]);

    const summaries = await listSessionSummaries(page);
    assert.deepEqual(summaries.map((s) => s.session.id), ["new", "old"]); // newest first, like listSessions
    assert.equal(summaries[0].actionCount, 3);
    assert.equal(summaries[0].tabCount, 2);
    assert.equal(summaries[1].actionCount, 1);
    assert.equal(summaries[1].tabCount, 0, "no events were ever added for the old session");
  });
});

// Item 6: age-based pruning can delete a tab's FullSnapshot row and keep its
// later incremental rows (their own ts isn't old enough on its own), leaving a
// stream that starts mid-replay with no base to apply the increments onto.
// addEvents stamps its row with the real wall clock (its signature takes no
// ts), so a real sleep separates the two rows in time, the same way the
// "still active" prune test above does for actions/events under a session.
test("prune also deletes a tab's trailing incremental-only rows once their own FullSnapshot ages out (item 6)", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withStore(async (page) => {
    await upsert(page, { id: "s1", label: "app", cwd: "/x", pid: 1 }, Date.now());
    await addEvents(page, "s1", 1, [{ type: 2, data: {} }]); // tab 1's only FullSnapshot
    await new Promise((r) => setTimeout(r, 500));
    await addEvents(page, "s1", 1, [{ type: 3, data: {} }]); // a later, incremental-only batch
    await addEvents(page, "s1", 2, [{ type: 2, data: {} }]); // tab 2: an unrelated, recent stream
    await upsert(page, { id: "s1", label: "app", cwd: "/x", pid: 1 }, Date.now()); // keep the session itself "active"

    const dayMs = 24 * 60 * 60 * 1000;
    await prune(page, { retentionDays: 250 / dayMs, maxSessions: 200, now: Date.now() }); // cutoff ~250ms ago

    const { eventsByTab } = await getSession(page, "s1");
    assert.equal(eventsByTab[1], undefined, "tab 1's surviving row has no FullSnapshot of its own left and must be removed too");
    assert.equal(eventsByTab[2].length, 1, "tab 2's own recent FullSnapshot is unaffected");
  });
});

const tabCount = async (page, id) => (await listSessionSummaries(page)).find((s) => s.session.id === id).tabCount;

// Every audited call upserts its session twice (when it starts and when it is
// recorded), and that must not reset the tab ids addEvents keeps on the row.
test("the tab count survives the upsertSession of a later audited call", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withStore(async (page) => {
    await upsert(page, { id: "s1", label: "app", cwd: "/x", pid: 1 }, 1000);
    await addEvents(page, "s1", 11, [{ type: 4, timestamp: 1 }, { type: 2, timestamp: 2 }]);
    await addEvents(page, "s1", 12, [{ type: 4, timestamp: 3 }, { type: 2, timestamp: 4 }]);
    await upsert(page, { id: "s1", label: "app", cwd: "/x", pid: 1 }, 2000);
    assert.equal(await tabCount(page, "s1"), 2);
    await addEvents(page, "s1", 11, [{ type: 3, timestamp: 5 }]);
    assert.equal(await tabCount(page, "s1"), 2);
    const [session] = await listSessions(page);
    assert.equal(session.firstSeen, 1000);
    assert.equal(session.lastSeen, 2000);
  });
});

test("prune drops the tab ids whose events it deleted", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withStore(async (page) => {
    await upsert(page, { id: "s1", label: "app", cwd: "/x", pid: 1 }, Date.now() + 60_000); // stays active through the prune
    await addEvents(page, "s1", 11, [{ type: 4, timestamp: 1 }, { type: 2, timestamp: 2 }]); // ages out below
    await new Promise((r) => setTimeout(r, 500));
    await addEvents(page, "s1", 12, [{ type: 4, timestamp: 3 }, { type: 2, timestamp: 4 }]);
    await addEvents(page, "s1", 13, [{ type: 3, timestamp: 5 }]); // no FullSnapshot: nothing to replay from
    assert.equal(await tabCount(page, "s1"), 3);

    const dayMs = 24 * 60 * 60 * 1000;
    await prune(page, { retentionDays: 250 / dayMs, maxSessions: 200, now: Date.now() }); // cutoff ~250ms ago

    const { eventsByTab } = await getSession(page, "s1");
    assert.deepEqual(Object.keys(eventsByTab), ["12"]);
    assert.equal(await tabCount(page, "s1"), 1);
  });
});

// A batch held back by the hasSession retry is stored after a later one, so key
// order is not time order. The replay sorts a stream by event timestamps, and
// so must prune.
test("prune keeps a FullSnapshot row stored after an incremental row of the same stream", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withStore(async (page) => {
    await upsert(page, { id: "s2", label: "app", cwd: "/x", pid: 1 }, Date.now());
    await addEvents(page, "s2", 21, [{ type: 3, timestamp: 3000, data: { source: 1 } }]);
    await addEvents(page, "s2", 21, [{ type: 4, timestamp: 1000 }, { type: 2, timestamp: 1001 }]);

    await prune(page, { retentionDays: 7, maxSessions: 200, now: Date.now() }); // nothing is old enough to age out

    const { eventsByTab } = await getSession(page, "s2");
    assert.deepEqual(eventsByTab[21].map((e) => e.timestamp), [3000, 1000, 1001]);
  });
});

test("prune deletes an incremental row older than the stream's first FullSnapshot, even when it was stored after it", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withStore(async (page) => {
    await upsert(page, { id: "s3", label: "app", cwd: "/x", pid: 1 }, Date.now());
    await addEvents(page, "s3", 31, [{ type: 4, timestamp: 1000 }, { type: 2, timestamp: 1001 }, { type: 3, timestamp: 1100, data: { source: 1 } }]);
    await addEvents(page, "s3", 31, [{ type: 3, timestamp: 500, data: { source: 1 } }]); // a late batch from before the snapshot

    await prune(page, { retentionDays: 7, maxSessions: 200, now: Date.now() });

    const { eventsByTab } = await getSession(page, "s3");
    assert.deepEqual(eventsByTab[31].map((e) => e.timestamp), [1000, 1001, 1100]);
  });
});

test("hasSession reports existence without fetching actions or events", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withStore(async (page) => {
    assert.equal(await hasSession(page, "s1"), false);
    await upsert(page, { id: "s1", label: "app", cwd: "/x", pid: 1 }, 1000);
    assert.equal(await hasSession(page, "s1"), true);
    await deleteSession(page, "s1");
    assert.equal(await hasSession(page, "s1"), false);
  });
});

// M6: a stale cached connection promise would make every future audit write
// fail (or hang) after a single dropped connection, until the service worker
// happens to restart. A versionchange (another connection wants to upgrade the
// database — e.g. a later schema bump) must not be one of those permanent-failure
// triggers: store.js's connection must get out of the way, not block it forever.
test("store.js releases its connection on versionchange instead of blocking a version bump from elsewhere", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withStore(async (page) => {
    await upsert(page, { id: "s1", label: "a", cwd: "/x", pid: 1 }, 1000); // proves the v1 connection is open and working
    const outcome = await page.evaluate(`
      new Promise((resolve) => {
        const req = indexedDB.open("ocic-audit", 2);
        req.onupgradeneeded = () => {};
        req.onsuccess = () => { req.result.close(); resolve("success"); };
        req.onerror = () => resolve("error:" + (req.error && req.error.name));
        req.onblocked = () => resolve("blocked");
        setTimeout(() => resolve("timeout"), 3000);
      })
    `);
    assert.equal(outcome, "success");
  });
});

// M8: the three classic scripts share the worker's (or, here, the page's) global
// scope. store.js must not leak its internal helpers, and must not replace
// window.open — a real collision confirmed in the review (Task 17 loads
// store.js on options.html).
test("store.js exposes only globalThis.AuditStore and leaves window.open alone", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withStore(async (page) => {
    const clean = await page.evaluate(`
      (function () {
        const noInternals = typeof openDb === "undefined" && typeof getDb === "undefined" &&
          typeof reqp === "undefined" && typeof upsertSession === "undefined" && typeof dbPromise === "undefined";
        const openIsNative = typeof window.open === "function" && window.open.toString().indexOf("[native code]") !== -1;
        return noInternals && openIsNative;
      })()
    `);
    assert.equal(clean, true);
  });
});

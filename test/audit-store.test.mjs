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

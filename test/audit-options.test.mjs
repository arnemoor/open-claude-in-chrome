// Exercises extension/options.html + options.js against real Chrome: the audit
// settings checkbox/select, the sessions table, session detail (actions + rrweb
// replay), JSON export, delete, and the fix-round-1 hardening (I1: no outbound
// requests from a replay; I2: a stale or broken session can't corrupt Delete or
// Export; M1-M9: see task-17-fix-r1.md). IndexedDB needs a real origin, so
// extension/ is served from a local http server (same pattern as
// audit-store.test.mjs).
//
// chrome.storage.local is stubbed with Page.addScriptToEvaluateOnNewDocument
// (installed before navigation) so it runs without the real extension APIs;
// AuditStore itself is the real extension/audit/store.js, loaded by options.html
// like the production page would.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromeAvailable, launchChrome, openPage, navigate } from "./harness/browser.mjs";

const EXT_DIR = path.join(import.meta.dirname, "..", "extension");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

// Hand-made (not captured) rrweb event fixtures: a Meta event, a FullSnapshot of
// a tiny DOM, plus one incremental event so a replay has a non-zero duration to
// seek within. No real page content, no secrets.
const FIXTURE_EVENTS = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "fixtures", "rrweb-events.hand-made.json"), "utf8"),
);
// A second fixture whose DOM references "__REMOTE__" resource URLs (img src, a
// stylesheet link, a CSS @import, a CSS background). The I1 test replaces
// "__REMOTE__" with a throwaway local server's origin and asserts it gets 0
// requests while a replay opens, seeks and switches tabs.
const REMOTE_FIXTURE_TEMPLATE = fs.readFileSync(
  path.join(import.meta.dirname, "fixtures", "rrweb-events-remote-resources.hand-made.json"), "utf8",
);

const SESSION = { id: "s1", label: "myapp", cwd: "/Users/x/app", pid: 4242 };
const ACTION_1 = { sessionId: "s1", ts: 1200, tool: "navigate", tabId: 11, summary: "https://example.test/", outcome: "ok", ms: 12 };
const ACTION_2 = { sessionId: "s1", ts: 1800, tool: "computer", tabId: 11, summary: "left_click at (10, 20)", outcome: "ok", ms: 5 };

// Installed via Page.addScriptToEvaluateOnNewDocument, before the real page
// scripts run. Backs chrome.storage.local with an in-memory object exposed as
// window.__storageState so tests can assert on what options.js wrote, and can
// be pre-seeded (e.g. to test a stored value the UI doesn't offer, M7).
function storageStubSource(initialState = {}) {
  return `(() => {
    const state = ${JSON.stringify(initialState)};
    globalThis.__storageState = state;
    globalThis.chrome = {
      storage: {
        local: {
          get(keys) {
            return Promise.resolve().then(() => {
              if (keys == null) return { ...state };
              const list = Array.isArray(keys) ? keys : [keys];
              const out = {};
              for (const k of list) if (k in state) out[k] = state[k];
              return out;
            });
          },
          set(items) {
            return Promise.resolve().then(() => { Object.assign(state, items); });
          },
        },
      },
    };
  })();`;
}

function serveExtension() {
  return http.createServer((req, res) => {
    const reqPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const filePath = path.join(EXT_DIR, reqPath);
    if (!filePath.startsWith(EXT_DIR)) { res.writeHead(403); res.end(); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
      res.end(data);
    });
  });
}

// A server that only counts requests, standing in for an attacker-controlled
// host that a recorded page's DOM might reference (I1).
function countingServer() {
  const state = { count: 0 };
  const server = http.createServer((req, res) => {
    state.count++;
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("");
  });
  return { server, state };
}

async function waitFor(page, expr, { timeout = 5000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(expr)) return;
    if (Date.now() > deadline) throw new Error(`waitFor timed out waiting for: ${expr}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

// Repeats `actionExpr` (not just waits) until `predicateExpr` is true: options.js
// attaches its listeners asynchronously (after chrome.storage.local.get()
// resolves), so a single dispatch right after navigation can race ahead of that
// and be lost. Re-dispatching is harmless (setting .checked to the same value
// twice is a no-op).
async function retryUntil(page, actionExpr, predicateExpr, { timeout = 5000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    await page.evaluate(actionExpr);
    if (await page.evaluate(predicateExpr)) return;
    if (Date.now() > deadline) throw new Error(`retryUntil timed out waiting for: ${predicateExpr}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

// Opens extension/options.html (with the chrome.storage stub already installed)
// on a fresh local-server origin, so each test gets its own isolated IndexedDB,
// runs `fn(page, origin)`, then tears the server down.
async function withOptionsPage(fn, { initialStorage } = {}) {
  const server = serveExtension();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  try {
    const page = await openPage(browser);
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: storageStubSource(initialStorage) });
    await navigate(page, `${origin}/options.html`);
    await fn(page, origin);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const seedSession = (page, session, ts) => page.evaluate(`AuditStore.upsertSession(${JSON.stringify(session)}, ${ts})`);
const seedAction = (page, action) => page.evaluate(`AuditStore.addAction(${JSON.stringify(action)})`);
const seedEvents = (page, sessionId, tabId, events) => page.evaluate(`AuditStore.addEvents(${JSON.stringify(sessionId)}, ${tabId}, ${JSON.stringify(events)})`);

// Seeds through the page's own (already-loaded) AuditStore, then reloads
// options.html so its init() renders against the now-populated IndexedDB —
// avoids racing the first load's own (empty-DB) render.
async function seedAndReload(page, origin, { session = SESSION, ts = 1000, actions = [ACTION_1, ACTION_2], events = { 11: FIXTURE_EVENTS } } = {}) {
  await page.evaluate(`AuditStore.open()`);
  await seedSession(page, session, ts);
  for (const action of actions) await seedAction(page, action);
  for (const [tabId, tabEvents] of Object.entries(events)) await seedEvents(page, session.id, Number(tabId), tabEvents);
  await navigate(page, `${origin}/options.html`);
}

let browser;
before(async () => { if (chromeAvailable) browser = await launchChrome(); }, { timeout: 30000 });
after(() => browser?.close());

test("ticking the audit checkbox, and choosing a retention, write to chrome.storage.local", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withOptionsPage(async (page) => {
    // Both use retryUntil: init() wires these listeners asynchronously, so an
    // interaction dispatched right after navigation can land before they're
    // attached (or, for the select specifically, before init() has even set
    // its initial value — a bare, un-retried set here would otherwise race
    // initSettings() and get silently overwritten back to the loaded value).
    await retryUntil(
      page,
      `(() => {
        const sel = document.getElementById("audit-retention");
        sel.value = "30";
        sel.dispatchEvent(new Event("change"));
      })()`,
      `window.__storageState.audit != null && window.__storageState.audit.retentionDays === 30`,
    );
    await retryUntil(
      page,
      `(() => {
        const cb = document.getElementById("audit-enabled");
        cb.checked = true;
        cb.dispatchEvent(new Event("change"));
      })()`,
      `window.__storageState.audit != null && window.__storageState.audit.enabled === true`,
    );
    const audit = await page.evaluate("window.__storageState.audit");
    assert.deepEqual(audit, { enabled: true, retentionDays: 30 });
  });
});

test("a stored retention value outside 1/7/30 falls back to 7 in the UI and in what is written (M7)", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withOptionsPage(async (page) => {
    assert.equal(await page.evaluate(`document.getElementById("audit-retention").value`), "7");

    await retryUntil(
      page,
      `(() => {
        const cb = document.getElementById("audit-enabled");
        cb.checked = true;
        cb.dispatchEvent(new Event("change"));
      })()`,
      `window.__storageState.audit != null`,
    );
    assert.deepEqual(await page.evaluate("window.__storageState.audit"), { enabled: true, retentionDays: 7 });
  }, { initialStorage: { audit: { enabled: false, retentionDays: 14 } } });
});

test("a plain visit never creates the audit database, and the switch still works (M3, M4)", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withOptionsPage(async (page) => {
    await waitFor(page, `document.getElementById("sessions-empty").hidden === false`);
    assert.equal(await page.evaluate(`document.querySelectorAll("#sessions-body tr").length`), 0);

    const before_ = await page.evaluate(`(async () => (await indexedDB.databases()).map((d) => d.name))()`);
    assert.ok(!before_.includes("ocic-audit"), `expected no ocic-audit db before any interaction, got ${JSON.stringify(before_)}`);

    await retryUntil(
      page,
      `(() => {
        const cb = document.getElementById("audit-enabled");
        cb.checked = true;
        cb.dispatchEvent(new Event("change"));
      })()`,
      `window.__storageState.audit != null`,
    );
    assert.deepEqual(await page.evaluate("window.__storageState.audit"), { enabled: true, retentionDays: 7 });

    const after_ = await page.evaluate(`(async () => (await indexedDB.databases()).map((d) => d.name))()`);
    assert.ok(!after_.includes("ocic-audit"), `expected still no ocic-audit db after toggling the switch, got ${JSON.stringify(after_)}`);
  });
});

test("sessions table, session detail with replay, export, and delete", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withOptionsPage(async (page, origin) => {
    await seedAndReload(page, origin);
    await waitFor(page, `document.querySelectorAll("#sessions-body tr").length === 1`);

    const rowCells = await page.evaluate(`Array.from(document.querySelectorAll("#sessions-body tr td")).map((td) => td.textContent)`);
    assert.equal(rowCells[0], "myapp");
    assert.equal(rowCells[1], "/Users/x/app");
    assert.equal(rowCells[2], "4242");
    assert.ok(rowCells[3].length > 0, "first-seen cell should not be empty");
    assert.ok(rowCells[4].length > 0, "last-seen cell should not be empty");
    assert.equal(rowCells[5], "2", "action count");
    assert.equal(rowCells[6], "1", "tab count");

    // M8: the label cell holds a real, keyboard-reachable button, not a bare click target.
    assert.equal(await page.evaluate(`document.querySelector("#sessions-body tr td button").tagName`), "BUTTON");
    await page.evaluate(`document.querySelector("#sessions-body tr td button").click()`);

    await waitFor(page, `document.querySelectorAll("#actions-body tr").length === 2`);
    await waitFor(page, `!!document.querySelector(".rr-player")`);

    // M9: the player fits its column instead of overflowing it.
    const widths = await page.evaluate(`(() => {
      const player = document.querySelector(".rr-player");
      const container = document.getElementById("player-container");
      return { player: player.getBoundingClientRect().width, container: container.getBoundingClientRect().width };
    })()`);
    assert.ok(widths.player <= widths.container + 1, `player ${widths.player}px should fit its ${widths.container}px column`);

    // Export is built lazily on click (M5): click and read within one evaluate
    // call, ahead of the short-lived blob URL's revoke.
    const exportInfo = await page.evaluate(`(async () => {
      const a = document.getElementById("export-session");
      a.click();
      const hasDownload = a.hasAttribute("download");
      const isBlob = a.href.startsWith("blob:");
      const text = await (await fetch(a.href)).text();
      return { hasDownload, isBlob, text };
    })()`);
    assert.equal(exportInfo.hasDownload, true);
    assert.equal(exportInfo.isBlob, true);
    const exported = JSON.parse(exportInfo.text);
    assert.equal(exported.session.id, "s1");

    await page.evaluate(`document.getElementById("delete-session").click()`);
    await waitFor(page, `document.querySelectorAll("#sessions-body tr").length === 0`);

    // M1: all three stores are empty for this session, not only listSessions().
    const remaining = await page.evaluate(`AuditStore.getSession("s1")`);
    assert.equal(remaining.session, undefined);
    assert.equal(remaining.actions.length, 0);
    assert.equal(Object.keys(remaining.eventsByTab).length, 0);
  });
});

test("seek and tab switch move the same replayer, and re-creating it leaves exactly one player (M2)", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withOptionsPage(async (page, origin) => {
    const actionTab1 = { sessionId: "s1", ts: 1200, tool: "navigate", tabId: 11, summary: "https://example.test/", outcome: "ok", ms: 12 };
    const actionTab2 = { sessionId: "s1", ts: 1800, tool: "computer", tabId: 12, summary: "left_click at (10, 20)", outcome: "ok", ms: 5 };
    await seedAndReload(page, origin, { actions: [actionTab1, actionTab2], events: { 11: FIXTURE_EVENTS, 12: FIXTURE_EVENTS } });
    await waitFor(page, `document.querySelectorAll("#sessions-body tr").length === 1`);

    await page.evaluate(`document.querySelector("#sessions-body tr td button").click()`);
    await waitFor(page, `document.querySelectorAll("#actions-body tr").length === 2`);
    await waitFor(page, `!!document.querySelector(".rr-player")`);

    assert.deepEqual(await page.evaluate(`Array.from(document.getElementById("tab-select").options).map((o) => o.value)`), ["11", "12"]);
    assert.equal(await page.evaluate(`document.getElementById("tab-select").value`), "11");

    // The second action row belongs to tab 12: clicking it switches the tab
    // selector and seeks the newly created player to action.ts - firstEventTs.
    await page.evaluate(`document.querySelectorAll("#actions-body tr")[1].click()`);
    await waitFor(page, `document.getElementById("tab-select").value === "12"`);
    await waitFor(page, `document.querySelectorAll(".rr-player").length === 1`);

    const currentTime = await page.evaluate(`currentPlayer.getReplayer().getCurrentTime()`);
    assert.equal(currentTime, 800); // 1800 - 1000 (tab 12's first event timestamp)

    // Switching tabs by hand still leaves exactly one .rr-player (re-create, not append).
    await page.evaluate(`(() => {
      const sel = document.getElementById("tab-select");
      sel.value = "11";
      sel.dispatchEvent(new Event("change"));
    })()`);
    await waitFor(page, `document.querySelectorAll(".rr-player").length === 1`);
  });
});

test("a replay never sends the recorded page's resource URLs to the network (I1)", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { server: attackerServer, state } = countingServer();
  await new Promise((resolve) => attackerServer.listen(0, "127.0.0.1", resolve));
  const attackerOrigin = `http://127.0.0.1:${attackerServer.address().port}`;

  try {
    const remoteEvents = JSON.parse(REMOTE_FIXTURE_TEMPLATE.replaceAll("__REMOTE__", attackerOrigin));

    await withOptionsPage(async (page, origin) => {
      const actionTab1 = { sessionId: "s1", ts: 1200, tool: "navigate", tabId: 11, summary: "https://example.test/", outcome: "ok", ms: 12 };
      const actionTab2 = { sessionId: "s1", ts: 1800, tool: "computer", tabId: 12, summary: "left_click at (10, 20)", outcome: "ok", ms: 5 };
      await seedAndReload(page, origin, { actions: [actionTab1, actionTab2], events: { 11: remoteEvents, 12: remoteEvents } });
      await waitFor(page, `document.querySelectorAll("#sessions-body tr").length === 1`);

      // Opening the detail view builds the first player (a rebuild that would
      // otherwise fetch every resource in the recorded DOM).
      await page.evaluate(`document.querySelector("#sessions-body tr td button").click()`);
      await waitFor(page, `document.querySelectorAll("#actions-body tr").length === 2`);
      await waitFor(page, `!!document.querySelector(".rr-player")`);

      // A seek within the same tab.
      await page.evaluate(`document.querySelectorAll("#actions-body tr")[0].click()`);
      await new Promise((r) => setTimeout(r, 200));

      // A tab switch: a second player construction/rebuild.
      await page.evaluate(`document.querySelectorAll("#actions-body tr")[1].click()`);
      await waitFor(page, `document.getElementById("tab-select").value === "12"`);
      await new Promise((r) => setTimeout(r, 200));

      assert.ok(await page.evaluate(`!!document.querySelector(".rr-player")`), "the player should still render under the page CSP");
    });

    // A settle window for anything that might still be in flight.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(state.count, 0, `expected 0 requests to the attacker-like server, got ${state.count}`);
  } finally {
    await new Promise((resolve) => attackerServer.close(resolve));
  }
});

test("a session that disappears while its stale row is clicked leaves other sessions untouched (I2)", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withOptionsPage(async (page, origin) => {
    const keep = { id: "keepme", label: "keepme-app", cwd: "/a", pid: 1 };
    const pruned = { id: "pruned", label: "pruned-app", cwd: "/b", pid: 2 };
    await page.evaluate(`AuditStore.open()`);
    await seedSession(page, keep, 1000);
    await seedSession(page, pruned, 2000);
    await seedAction(page, { sessionId: "keepme", ts: 1100, tool: "navigate", tabId: 11, summary: "https://example.test/", outcome: "ok", ms: 1 });
    await seedEvents(page, "keepme", 11, FIXTURE_EVENTS);
    await navigate(page, `${origin}/options.html`);
    await waitFor(page, `document.querySelectorAll("#sessions-body tr").length === 2`);

    // Newest first: "pruned" (lastSeen 2000) before "keepme" (lastSeen 1000).
    const labels = await page.evaluate(`Array.from(document.querySelectorAll("#sessions-body tr td button")).map((b) => b.textContent)`);
    assert.deepEqual(labels, ["pruned-app", "keepme-app"]);

    // Open "keepme"'s detail.
    await page.evaluate(`Array.from(document.querySelectorAll("#sessions-body tr td button")).find((b) => b.textContent === "keepme-app").click()`);
    await waitFor(page, `!!document.querySelector(".rr-player")`);

    // Delete "pruned" from under the page (simulates the hourly audit-prune alarm).
    await page.evaluate(`AuditStore.deleteSession("pruned")`);

    // Click the now-stale "pruned" row.
    await page.evaluate(`Array.from(document.querySelectorAll("#sessions-body tr td button")).find((b) => b.textContent === "pruned-app").click()`);
    await waitFor(page, `document.getElementById("session-detail").hidden === true`);
    await waitFor(page, `document.querySelectorAll("#sessions-body tr").length === 1`);

    const notice = await page.evaluate(`document.getElementById("sessions-notice").textContent`);
    assert.match(notice, /no longer exists/);

    const stillThere = await page.evaluate(`AuditStore.getSession("keepme")`);
    assert.equal(stillThere.session.id, "keepme");
    assert.equal(stillThere.actions.length, 1);
  });
});

test("a session with a broken replay stream shows a notice but keeps the actions, and Delete still removes it (I2)", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withOptionsPage(async (page, origin) => {
    const brokenEvents = [FIXTURE_EVENTS[0], FIXTURE_EVENTS[1], null];
    await seedAndReload(page, origin, { events: { 11: brokenEvents } });
    await waitFor(page, `document.querySelectorAll("#sessions-body tr").length === 1`);

    await page.evaluate(`document.querySelector("#sessions-body tr td button").click()`);
    await waitFor(page, `document.querySelectorAll("#actions-body tr").length === 2`);
    await waitFor(page, `document.getElementById("player-notice").hidden === false`);

    const notice = await page.evaluate(`document.getElementById("player-notice").textContent`);
    assert.match(notice, /[Rr]eplay unavailable/);
    assert.equal(await page.evaluate(`!!document.querySelector(".rr-player")`), false);

    await page.evaluate(`document.getElementById("delete-session").click()`);
    await waitFor(page, `document.querySelectorAll("#sessions-body tr").length === 0`);
    assert.equal(await page.evaluate(`AuditStore.listSessions().then((s) => s.length)`), 0);
  });
});

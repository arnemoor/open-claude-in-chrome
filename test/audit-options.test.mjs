// Exercises extension/options.html + options.js against real Chrome: the audit
// settings checkbox/select, the sessions table, session detail (actions + rrweb
// replay), JSON export, delete, and the fix-round hardening (I1: no outbound
// requests from a replay; I2/N3: a stale, broken or slow-loading session can't
// corrupt Delete or Export; N1: exports must never touch the real ~/Downloads;
// M1-M9/N2/N4/N5: see task-17-fix-r1.md and task-17-fix-r2.md). IndexedDB needs
// a real origin, so extension/ is served from a local http server (same
// pattern as audit-store.test.mjs).
//
// chrome.storage.local is stubbed with Page.addScriptToEvaluateOnNewDocument
// (installed before navigation) so it runs without the real extension APIs;
// AuditStore itself is the real extension/audit/store.js, loaded by options.html
// like the production page would.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromeAvailable, launchChrome, openPage, navigate } from "./harness/browser.mjs";

const EXT_DIR = path.join(import.meta.dirname, "..", "extension");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

// N1: the export path must never write into the user's real ~/Downloads. The
// browser-level "deny" set in before() is the primary guard; this direct
// filesystem check is the belt-and-suspenders the ruling asks for.
const DOWNLOADS_DIR = path.join(os.homedir(), "Downloads");
function listAuditDownloads() {
  try {
    return fs.readdirSync(DOWNLOADS_DIR).filter((f) => f.startsWith("audit-session-")).sort();
  } catch (err) {
    if (err.code === "ENOENT") return []; // no Downloads dir at all
    throw err; // any other error (e.g. a permissions denial) must not read as a silent, clean pass
  }
}

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
// be pre-seeded (e.g. to test a stored value the UI doesn't offer, M7) and/or
// delayed (M3 rest: a click landing mid-read must not be reverted once a slow
// read finally resolves).
function storageStubSource(initialState = {}, delayMs = 0) {
  return `(() => {
    const state = ${JSON.stringify(initialState)};
    globalThis.__storageState = state;
    globalThis.__storageWrites = [];
    globalThis.chrome = {
      storage: {
        local: {
          get(keys) {
            // Real chrome.storage ordering: a get() call's answer is captured
            // when it is issued, not when it happens to resolve — a set()
            // that lands while this one is still pending must not change
            // what it returns (item 2/N6's own regression test relies on
            // this to tell "written early, then correctly re-saved" apart
            // from "written early, then silently kept").
            const snapshot = { ...state };
            return new Promise((resolve) => setTimeout(() => {
              if (keys == null) return resolve({ ...snapshot });
              const list = Array.isArray(keys) ? keys : [keys];
              const out = {};
              for (const k of list) if (k in snapshot) out[k] = snapshot[k];
              resolve(out);
            }, ${delayMs}));
          },
          set(items) {
            globalThis.__storageWrites.push(JSON.parse(JSON.stringify(items)));
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
// host that a recorded page's DOM might reference (I1). It counts connections
// too, since a preconnect opens one without sending a request.
function countingServer() {
  const state = { count: 0, connections: 0 };
  const server = http.createServer((req, res) => {
    state.count++;
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("");
  });
  server.on("connection", () => { state.connections++; });
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

// Repeats `actionExpr` (not just waits) until `predicateExpr` is true.
// navigate() resolves on Page.loadEventFired, which comes after all three
// blocking <script src> tags, so options.js has attached its listeners by
// then. But navigate() also resolves after 5s when no load event arrives, and
// a change is saved asynchronously (the handler reads storage before it
// writes), so one dispatch and one check can still miss. Dispatching the same
// value again is harmless.
async function retryUntil(page, actionExpr, predicateExpr, { timeout = 5000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    await page.evaluate(actionExpr);
    if (await page.evaluate(predicateExpr)) return;
    if (Date.now() > deadline) throw new Error(`retryUntil timed out waiting for: ${predicateExpr}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

// Opens extension/options.html (with the chrome.storage stub already installed,
// and optionally a rejecting indexedDB.databases()) on a fresh local-server
// origin, so each test gets its own isolated IndexedDB, runs `fn(page, origin)`,
// then tears the server down.
async function withOptionsPage(fn, { initialStorage, storageDelayMs, rejectDbEnumeration } = {}) {
  const server = serveExtension();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  try {
    const page = await openPage(browser);
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: storageStubSource(initialStorage, storageDelayMs) });
    if (rejectDbEnumeration) {
      await page.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `indexedDB.databases = () => Promise.reject(new Error("simulated enumeration failure"));`,
      });
    }
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

// Two independent sessions for the N3 tests: "session-a" is opened first and
// must stay untouched; "session-b" is the one whose load gets slowed or made
// to reject.
async function seedTwoSessions(page, origin) {
  const a = { id: "sessA", label: "session-a", cwd: "/a", pid: 1 };
  const b = { id: "sessB", label: "session-b", cwd: "/b", pid: 2 };
  await page.evaluate(`AuditStore.open()`);
  await seedSession(page, a, 1000);
  await seedSession(page, b, 2000);
  await seedAction(page, { sessionId: "sessA", ts: 1100, tool: "navigate", tabId: 11, summary: "https://example.test/", outcome: "ok", ms: 1 });
  await seedEvents(page, "sessA", 11, FIXTURE_EVENTS);
  // A distinct tool from session-a's "navigate" (item 11): lets a test tell
  // session-b's own action apart from a leftover from session-a's detail.
  await seedAction(page, { sessionId: "sessB", ts: 2100, tool: "computer", tabId: 12, summary: "left_click at (10, 20)", outcome: "ok", ms: 1 });
  await seedEvents(page, "sessB", 12, FIXTURE_EVENTS);
  await navigate(page, `${origin}/options.html`);
  await waitFor(page, `document.querySelectorAll("#sessions-body tr").length === 2`);
}

const clickByLabel = (page, label) => page.evaluate(`Array.from(document.querySelectorAll("#sessions-body tr td button")).find((b) => b.textContent === ${JSON.stringify(label)}).click()`);

let browser;
let downloadsAtStart;
before(async () => {
  downloadsAtStart = listAuditDownloads();
  if (chromeAvailable) {
    browser = await launchChrome();
    // N1: deny all downloads at the browser level. An earlier version of the
    // export test clicked a real <a download>, and headless Chrome saved it
    // into the user's actual ~/Downloads on every run (nothing here needs a
    // saved file — only the Blob's content, verified in-page below).
    await browser.send("Browser.setDownloadBehavior", { behavior: "deny" });
  }
}, { timeout: 30000 });

after(async () => {
  await browser?.close();
  const downloadsAtEnd = listAuditDownloads();
  assert.deepEqual(downloadsAtEnd, downloadsAtStart, `no audit-session-* files should appear in ${DOWNLOADS_DIR} from this suite`);
});

test("ticking the audit checkbox, and choosing a retention, write to chrome.storage.local", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withOptionsPage(async (page) => {
    // Both use retryUntil, see its own comment.
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

test("a click on the audit switch during a slow storage read is written and kept, not reverted once the read resolves (M3 rest)", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withOptionsPage(async (page) => {
    // No retry here: the point is to land while chrome.storage.local.get() is
    // still pending, which the listeners (now attached before that call, per
    // the fix) must not miss.
    await page.evaluate(`(() => {
      const cb = document.getElementById("audit-enabled");
      cb.checked = true;
      cb.dispatchEvent(new Event("change"));
    })()`);
    await waitFor(page, `window.__storageState.audit.enabled === true`);
    assert.equal((await page.evaluate("window.__storageState.audit")).enabled, true);

    // Wait past the stub's artificial delay: the stale stored enabled:false
    // must not overwrite the user's own click once the read finally resolves.
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(await page.evaluate(`document.getElementById("audit-enabled").checked`), true);
    assert.equal((await page.evaluate("window.__storageState.audit")).enabled, true);
  }, { initialStorage: { audit: { enabled: false, retentionDays: 7 } }, storageDelayMs: 400 });
});

// N6 (new regression from the M3 fix): the click above is saved together with
// the OTHER control's still-unset markup default (retention "1 day", since
// the select hasn't been set from storage yet) — clobbering whatever
// retentionDays was actually stored, even though the select itself later
// shows the right value once the read resolves. Asserts the whole stored
// object, as the earlier re-review asked for.
test("a click on the audit switch during a slow storage read does not clobber the stored retention with the select's markup default (N6)", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withOptionsPage(async (page) => {
    await page.evaluate(`(() => {
      const cb = document.getElementById("audit-enabled");
      cb.checked = true;
      cb.dispatchEvent(new Event("change"));
    })()`);
    await waitFor(page, `window.__storageState.audit.enabled === true`);

    await new Promise((r) => setTimeout(r, 600)); // past the stub's artificial delay
    assert.deepEqual(await page.evaluate("window.__storageState.audit"), { enabled: true, retentionDays: 30 });
    assert.equal(await page.evaluate(`document.getElementById("audit-retention").value`), "30");
  }, { initialStorage: { audit: { enabled: false, retentionDays: 30 } }, storageDelayMs: 400 });
});

// Before the first storage read resolves, the control the user did not touch
// still shows its markup default (retention "1 day", the switch off). No write
// may carry that default, not even for one round trip.
test("a change during a slow storage read never writes the other control's markup default", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withOptionsPage(async (page) => {
    await page.evaluate(`(() => {
      const cb = document.getElementById("audit-enabled");
      cb.checked = true;
      cb.dispatchEvent(new Event("change"));
    })()`);
    await waitFor(page, `window.__storageState.audit.enabled === true`);
    await new Promise((r) => setTimeout(r, 600));
    const writes = await page.evaluate("window.__storageWrites");
    assert.deepEqual(writes.map((w) => w.audit), writes.map(() => ({ enabled: true, retentionDays: 30 })));
  }, { initialStorage: { audit: { enabled: false, retentionDays: 30 } }, storageDelayMs: 400 });

  await withOptionsPage(async (page) => {
    await page.evaluate(`(() => {
      const sel = document.getElementById("audit-retention");
      sel.value = "30";
      sel.dispatchEvent(new Event("change"));
    })()`);
    await waitFor(page, `window.__storageState.audit.retentionDays === 30`);
    await new Promise((r) => setTimeout(r, 600));
    const writes = await page.evaluate("window.__storageWrites");
    assert.deepEqual(writes.map((w) => w.audit), writes.map(() => ({ enabled: true, retentionDays: 30 })));
  }, { initialStorage: { audit: { enabled: true, retentionDays: 7 } }, storageDelayMs: 400 });
});

// Each save reads storage before it writes, so two saves in flight at once
// must not both read the old value and let the second undo the first.
test("two quick changes to different controls are both kept", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withOptionsPage(async (page) => {
    await page.evaluate(`(() => {
      const cb = document.getElementById("audit-enabled");
      cb.checked = true;
      cb.dispatchEvent(new Event("change"));
      const sel = document.getElementById("audit-retention");
      sel.value = "30";
      sel.dispatchEvent(new Event("change"));
    })()`);
    await waitFor(page, `window.__storageState.audit.enabled === true && window.__storageState.audit.retentionDays === 30`);
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(await page.evaluate("window.__storageState.audit"), { enabled: true, retentionDays: 30 });
  }, { initialStorage: { audit: { enabled: false, retentionDays: 7 } }, storageDelayMs: 100 });
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
      `window.__storageState.audit.enabled === true`,
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

test("indexedDB.databases() rejecting falls back to opening the database instead of leaving init() broken (N4)", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withOptionsPage(async (page, origin) => {
    await seedAndReload(page, origin);
    await waitFor(page, `document.querySelectorAll("#sessions-body tr").length === 1`);
    assert.equal(await page.evaluate(`document.querySelector("#sessions-body tr td button").textContent`), "myapp");
  }, { rejectDbEnumeration: true });
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

    // N2: Export is now a plain <button> (no public href), so verify the
    // actual Blob content by capturing what it passes to URL.createObjectURL
    // and the filename set on the anchor it clicks, rather than reading a
    // public href or letting a real download happen. Reading blob.text()
    // directly also sidesteps the short-lived revoke entirely (M5). N1: also
    // assert directly against the filesystem that nothing landed in the real
    // ~/Downloads, on top of the browser-level "deny" set in before().
    const downloadsBeforeExport = listAuditDownloads();
    const exportInfo = await page.evaluate(`(async () => {
      let blob = null;
      let filename = null;
      const realCreateObjectURL = URL.createObjectURL;
      URL.createObjectURL = (b) => { blob = b; return realCreateObjectURL(b); };
      const realClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { filename = this.download; return realClick.call(this); };
      document.getElementById("export-session").click();
      // Item 3: exportSession now loads a fresh session first, so the click
      // handler is async — the anchor's own .click() (and so this capture)
      // lands after this outer click() call has already returned.
      for (let i = 0; i < 50 && !blob; i++) await new Promise((r) => setTimeout(r, 20));
      URL.createObjectURL = realCreateObjectURL;
      HTMLAnchorElement.prototype.click = realClick;
      const text = blob ? await blob.text() : null;
      return { filename, type: blob ? blob.type : null, text };
    })()`);
    assert.equal(exportInfo.filename, "audit-session-s1.json");
    assert.equal(exportInfo.type, "application/json");
    const exported = JSON.parse(exportInfo.text);
    assert.equal(exported.session.id, "s1");
    assert.deepEqual(listAuditDownloads(), downloadsBeforeExport, "export must not write into the real ~/Downloads");

    await page.evaluate(`document.getElementById("delete-session").click()`);
    await waitFor(page, `document.querySelectorAll("#sessions-body tr").length === 0`);

    // M1: all three stores are empty for this session, not only listSessions().
    const remaining = await page.evaluate(`AuditStore.getSession("s1")`);
    assert.equal(remaining.session, undefined);
    assert.equal(remaining.actions.length, 0);
    assert.equal(Object.keys(remaining.eventsByTab).length, 0);
  });
});

// Important 1: with 200 sessions of real recordings, loading every session's
// full recording (tens of MB of rrweb events each) just to draw a 7-column
// table stalls or crashes the options tab. renderSessions must get its counts
// without ever calling getSession.
test("the sessions table renders action and tab counts without calling getSession per row (Important 1)", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withOptionsPage(async (page, origin) => {
    const actionTab2 = { sessionId: "s1", ts: 1900, tool: "find", tabId: 12, summary: "query: x", outcome: "ok", ms: 1 };
    await seedAndReload(page, origin, { actions: [ACTION_1, ACTION_2, actionTab2], events: { 11: FIXTURE_EVENTS, 12: FIXTURE_EVENTS } });
    await waitFor(page, `document.querySelectorAll("#sessions-body tr").length === 1`);

    await page.evaluate(`(() => {
      window.__getSessionCalls = 0;
      const real = AuditStore.getSession;
      AuditStore.getSession = (id) => { window.__getSessionCalls++; return real(id); };
    })()`);
    await page.evaluate(`renderSessions()`);
    await waitFor(page, `document.querySelectorAll("#sessions-body tr").length === 1`);

    assert.equal(await page.evaluate(`window.__getSessionCalls`), 0, "renderSessions must not load any session's full recording");
    const rowCells = await page.evaluate(`Array.from(document.querySelectorAll("#sessions-body tr td")).map((td) => td.textContent)`);
    assert.equal(rowCells[5], "3", "action count");
    assert.equal(rowCells[6], "2", "tab count");
  });
});

// Item 3: Export used to write the copy loaded when the detail was opened,
// so a session that kept recording after that missed its later actions.
test("Export loads a fresh copy of the session at click time, not the stale copy from when the detail opened (item 3)", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withOptionsPage(async (page, origin) => {
    await seedAndReload(page, origin);
    await waitFor(page, `document.querySelectorAll("#sessions-body tr").length === 1`);
    await page.evaluate(`document.querySelector("#sessions-body tr td button").click()`);
    await waitFor(page, `document.getElementById("session-detail").hidden === false`);

    // A new action lands on the live session after the detail was opened.
    await seedAction(page, { sessionId: "s1", ts: 2500, tool: "find", tabId: 11, summary: "query: late", outcome: "ok", ms: 2 });

    const exportText = await page.evaluate(`(async () => {
      let blob = null;
      const realCreateObjectURL = URL.createObjectURL;
      URL.createObjectURL = (b) => { blob = b; return realCreateObjectURL(b); };
      document.getElementById("export-session").click();
      for (let i = 0; i < 50 && !blob; i++) await new Promise((r) => setTimeout(r, 20));
      URL.createObjectURL = realCreateObjectURL;
      return blob ? await blob.text() : null;
    })()`);
    const exported = JSON.parse(exportText);
    assert.equal(exported.actions.length, 3, "expected the late-added action in the exported JSON");
  });
});

// Item 3: a failed Delete must show a notice instead of throwing or silently
// doing nothing.
test("a failed Export shows a notice instead of an unhandled rejection", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withOptionsPage(async (page, origin) => {
    await seedAndReload(page, origin);
    await waitFor(page, `document.querySelectorAll("#sessions-body tr").length === 1`);
    await page.evaluate(`document.querySelector("#sessions-body tr td button").click()`);
    await waitFor(page, `document.getElementById("session-detail").hidden === false`);

    await page.evaluate(`(() => {
      window.__unhandledRejections = 0;
      window.addEventListener("unhandledrejection", () => { window.__unhandledRejections++; });
      AuditStore.getSession = () => Promise.reject(new Error("boom"));
    })()`);
    await page.evaluate(`document.getElementById("export-session").click()`);
    await waitFor(page, `document.getElementById("sessions-notice").hidden === false`);

    assert.match(await page.evaluate(`document.getElementById("sessions-notice").textContent`), /[Cc]ould not export/);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await page.evaluate("window.__unhandledRejections"), 0);
  });
});

test("a failed Delete shows a notice instead of throwing (item 3)", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withOptionsPage(async (page, origin) => {
    await seedAndReload(page, origin);
    await waitFor(page, `document.querySelectorAll("#sessions-body tr").length === 1`);
    await page.evaluate(`document.querySelector("#sessions-body tr td button").click()`);
    await waitFor(page, `document.getElementById("session-detail").hidden === false`);

    await page.evaluate(`AuditStore.deleteSession = () => Promise.reject(new Error("boom"))`);
    await page.evaluate(`document.getElementById("delete-session").click()`);
    await waitFor(page, `document.getElementById("sessions-notice").hidden === false`);

    const notice = await page.evaluate(`document.getElementById("sessions-notice").textContent`);
    assert.match(notice, /[Cc]ould not delete/);
    assert.equal(await page.evaluate(`document.querySelectorAll("#sessions-body tr").length`), 1, "the session must still be listed: the failed delete changed nothing");
  });
});

test("Export is a real button, reachable by keyboard once a session is open (N2)", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withOptionsPage(async (page, origin) => {
    // #session-detail (and Export within it) is hidden until a session is
    // opened — any element inside a hidden ancestor is unfocusable regardless
    // of tag, so this must open one first. N2's actual bug was that the old
    // <a> had no href until the first click, so even once visible it wasn't
    // focusable; a plain <button> doesn't have that problem.
    await seedAndReload(page, origin);
    await waitFor(page, `document.querySelectorAll("#sessions-body tr").length === 1`);
    await page.evaluate(`document.querySelector("#sessions-body tr td button").click()`);
    await waitFor(page, `document.getElementById("session-detail").hidden === false`);

    assert.equal(await page.evaluate(`document.getElementById("export-session").tagName`), "BUTTON");

    // A real Tab key press (item 11), not .focus() — a copy with
    // tabindex="-1" on Export would still pass a .focus()-based check.
    await page.evaluate(`document.getElementById("delete-session").focus()`);
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    assert.equal(await page.evaluate(`document.activeElement.id`), "export-session");
  });
});

test("a click anywhere in a session row opens it once, without double-firing from the button (N5)", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withOptionsPage(async (page, origin) => {
    await seedAndReload(page, origin);
    await waitFor(page, `document.querySelectorAll("#sessions-body tr").length === 1`);

    await page.evaluate(`(() => {
      window.__getSessionCalls = 0;
      const real = AuditStore.getSession;
      AuditStore.getSession = (id) => { window.__getSessionCalls++; return real(id); };
    })()`);

    await page.evaluate(`document.querySelector("#sessions-body tr td button").click()`);
    await waitFor(page, `document.getElementById("session-detail").hidden === false`);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await page.evaluate(`window.__getSessionCalls`), 1, "clicking the button should open the session exactly once");

    await page.evaluate(`window.__getSessionCalls = 0; document.getElementById("session-detail").hidden = true;`);
    await page.evaluate(`document.querySelectorAll("#sessions-body tr td")[1].click()`); // the cwd cell, not the button
    await waitFor(page, `document.getElementById("session-detail").hidden === false`);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await page.evaluate(`window.__getSessionCalls`), 1, "a click on a non-button cell should also open the session, exactly once");
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

// Item 4: retried batches can arrive (and be stored) out of order, so
// tabEvents[0] is not reliably the earliest event. Stores the later-
// timestamped event in an earlier row than the Meta/FullSnapshot pair that
// actually starts the recording, simulating exactly that.
test("seeking uses the true earliest event timestamp for its offset, even when a later batch was stored first (item 4)", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withOptionsPage(async (page, origin) => {
    const action = { sessionId: "s1", ts: 1500, tool: "computer", tabId: 11, summary: "left_click at (1, 2)", outcome: "ok", ms: 1 };
    await page.evaluate(`AuditStore.open()`);
    await seedSession(page, SESSION, 1000);
    await seedAction(page, action);
    await seedEvents(page, "s1", 11, [FIXTURE_EVENTS[2]]); // the ts:2000 incremental event, stored FIRST
    await seedEvents(page, "s1", 11, [FIXTURE_EVENTS[0], FIXTURE_EVENTS[1]]); // the ts:1000 Meta/FullSnapshot, stored SECOND (as a retry would)
    await navigate(page, `${origin}/options.html`);
    await waitFor(page, `document.querySelectorAll("#sessions-body tr").length === 1`);

    await page.evaluate(`document.querySelector("#sessions-body tr td button").click()`);
    await waitFor(page, `document.querySelectorAll("#actions-body tr").length === 1`);
    await waitFor(page, `!!document.querySelector(".rr-player")`);

    await page.evaluate(`document.querySelectorAll("#actions-body tr")[0].click()`);
    await new Promise((r) => setTimeout(r, 100));
    const currentTime = await page.evaluate(`currentPlayer.getReplayer().getCurrentTime()`);
    assert.equal(currentTime, 500, "expected the offset from the true earliest event (ts 1000), not the array's first stored element (ts 2000)");
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

// Item 5: recorded <link rel="preconnect"|"dns-prefetch"|"prefetch"|"preload"
// |"prerender"> nodes still open real network connections when the player
// rebuilds them into the replay iframe — the CSP cannot block these the way
// it blocks a stylesheet/image/background fetch (proven by the I1 test
// above). Covers a node in the initial snapshot and one added later by a
// mutation; a same-batch, non-blocked stylesheet link must survive untouched.
test("preconnect/dns-prefetch/prefetch/preload/prerender link nodes are neutralized before the player is built (item 5)", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { server: attackerServer, state } = countingServer();
  await new Promise((resolve) => attackerServer.listen(0, "127.0.0.1", resolve));
  const attackerOrigin = `http://127.0.0.1:${attackerServer.address().port}`;

  try {
    const blockedRels = ["preconnect", "dns-prefetch", "prefetch", "preload", "prerender"];
    const linkNode = (id, rel) => ({ type: 2, tagName: "link", attributes: { rel, href: `${attackerOrigin}/${rel}` }, id, childNodes: [] });
    const snapshotEvents = [
      { type: 4, timestamp: 1000, data: { href: "https://example.test/fixture" } },
      {
        type: 2, timestamp: 1000,
        data: {
          node: {
            type: 0, id: 1, childNodes: [
              {
                type: 2, tagName: "html", attributes: {}, id: 2, childNodes: [
                  { type: 2, tagName: "head", attributes: {}, id: 3, childNodes: blockedRels.map((rel, i) => linkNode(10 + i, rel)) },
                  { type: 2, tagName: "body", attributes: {}, id: 4, childNodes: [] },
                ],
              },
            ],
          },
        },
      },
      // A later mutation adds one more blocked link, plus one allowed
      // stylesheet link — only the blocked one must be stripped.
      {
        type: 3, timestamp: 1500,
        data: {
          source: 0, texts: [], removes: [], attributes: [],
          adds: [
            { parentId: 3, nextId: null, node: linkNode(20, "preconnect") },
            { parentId: 3, nextId: null, node: { type: 2, tagName: "link", attributes: { rel: "stylesheet", href: `${attackerOrigin}/style.css` }, id: 21, childNodes: [] } },
          ],
        },
      },
    ];

    await withOptionsPage(async (page, origin) => {
      await seedAndReload(page, origin, { events: { 11: snapshotEvents } });
      await waitFor(page, `document.querySelectorAll("#sessions-body tr").length === 1`);

      await page.evaluate(`document.querySelector("#sessions-body tr td button").click()`);
      await waitFor(page, `document.querySelectorAll("#actions-body tr").length === 2`);
      await waitFor(page, `!!document.querySelector(".rr-player")`);
    });

    await new Promise((resolve) => setTimeout(resolve, 300)); // settle window for anything still in flight
    assert.equal(state.count, 0, `expected 0 requests to the attacker-like server from blocked link nodes, got ${state.count}`);
  } finally {
    await new Promise((resolve) => attackerServer.close(resolve));
  }
});

// A page that loads its CSS the loadCSS way records the link as rel=preload.
// When the sheet arrives, rrweb sends that node's rel change and its _cssText
// as mutations on the same id, which the player turns into a <style>. The node
// must survive neutralization for that to work.
const RECORD_JS = fs.readFileSync(path.join(EXT_DIR, "vendor", "rrweb-record.min.js"), "utf8");
const RECORD_OPTIONS = `{
  maskAllInputs: true, maskInputOptions: { password: true },
  maskTextSelector: '[contenteditable]:not([contenteditable="false"]), textarea',
  blockSelector: "input[type=hidden]", recordCanvas: false, collectFonts: false, inlineImages: false,
  sampling: { mousemove: 100, scroll: 150, input: "last" },
}`;
const LOADCSS_PAGE = `<!doctype html><html><head><link rel="preload" as="style" href="/late.css" onload="this.onload=null;this.rel='stylesheet'"></head><body><p id="t">hello</p></body></html>`;

async function recordLoadCssPage(siteOrigin) {
  const page = await openPage(browser);
  try {
    // Recording starts at DOMContentLoaded, before the delayed sheet arrives,
    // so the snapshot still has the link as rel=preload.
    await page.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `${RECORD_JS}\n;window.__ev = []; document.addEventListener("DOMContentLoaded", () => rrwebRecord.record({ emit: (e) => window.__ev.push(e), ...${RECORD_OPTIONS} }));`,
    });
    await navigate(page, `${siteOrigin}/`);
    await waitFor(page, `window.__ev.some((e) => e.type === 3 && e.data.source === 0 && e.data.attributes.some((a) => "_cssText" in a.attributes))`, { timeout: 8000 });
    return JSON.parse(await page.evaluate("JSON.stringify(window.__ev)"));
  } finally {
    await browser.send("Target.closeTarget", { targetId: page.targetId });
  }
}

test("a loadCSS-style preload link keeps its stylesheet in the replay, and the replay sends no request", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const site = { requests: 0 };
  const siteServer = http.createServer((req, res) => {
    site.requests++;
    if (req.url.startsWith("/late.css")) {
      setTimeout(() => { res.writeHead(200, { "Content-Type": "text/css" }); res.end("#t{color:rgb(1, 2, 3)}"); }, 1000);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(LOADCSS_PAGE);
  });
  await new Promise((resolve) => siteServer.listen(0, "127.0.0.1", resolve));
  try {
    const events = await recordLoadCssPage(`http://127.0.0.1:${siteServer.address().port}`);
    const link = JSON.stringify(events.find((e) => e.type === 2).data.node).match(/"rel":"preload"/);
    assert.ok(link, "the snapshot must hold the link as rel=preload, or this proves nothing");
    const requestsBeforeReplay = site.requests;
    const lastTs = Math.max(...events.map((e) => e.timestamp));

    await withOptionsPage(async (page, origin) => {
      const action = { sessionId: "s1", ts: lastTs + 50, tool: "computer", tabId: 11, summary: "screenshot", outcome: "ok", ms: 1 };
      await seedAndReload(page, origin, { ts: lastTs, actions: [action], events: { 11: events } });
      await waitFor(page, `document.querySelectorAll("#sessions-body tr").length === 1`);
      await page.evaluate(`document.querySelector("#sessions-body tr td button").click()`);
      await waitFor(page, `!!document.querySelector("#player-container iframe")`);

      await page.evaluate(`document.querySelectorAll("#actions-body tr")[0].click()`); // seeks past the _cssText mutations
      const colorExpr = `(() => {
        const doc = document.querySelector("#player-container iframe").contentDocument;
        const t = doc && doc.getElementById("t");
        return t ? doc.defaultView.getComputedStyle(t).color : null;
      })()`;
      await waitFor(page, `${colorExpr} === "rgb(1, 2, 3)"`, { timeout: 3000 }).catch(() => {});
      assert.equal(await page.evaluate(colorExpr), "rgb(1, 2, 3)", "the replay must keep the stylesheet the page loaded");
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(site.requests, requestsBeforeReplay, "the replay must not fetch the recorded link's href");
  } finally {
    await new Promise((resolve) => siteServer.close(resolve));
  }
});

// A blocked link stays in the replay, and what a later mutation sets on it
// reaches the replay too: an href on a prerender link fetches it while the
// replay plays. Links that were not blocked at first can also get a blocked
// rel, or an imagesrcset, later.
test("blocked links stay in the replay, and a later rel, href or imagesrcset cannot make one fetch", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  const { server: attackerServer, state } = countingServer();
  await new Promise((resolve) => attackerServer.listen(0, "127.0.0.1", resolve));
  const attackerOrigin = `http://127.0.0.1:${attackerServer.address().port}`;
  try {
    const link = (id, attributes) => ({ type: 2, tagName: "link", attributes, id, childNodes: [] });
    const events = [
      { type: 4, timestamp: 1000, data: { href: "https://example.test/fixture", width: 1024, height: 768 } },
      {
        type: 2, timestamp: 1000,
        data: {
          node: {
            type: 0, id: 1, childNodes: [{
              type: 2, tagName: "html", attributes: {}, id: 2, childNodes: [
                { type: 2, tagName: "head", attributes: {}, id: 3, childNodes: [
                  link(10, { rel: "prerender", href: `${attackerOrigin}/p10` }),
                  link(11, { rel: "preload", as: "image", href: `${attackerOrigin}/p11.png` }),
                  link(12, { rel: "stylesheet", href: `${attackerOrigin}/s12.css` }),
                  link(13, { rel: "icon", href: `${attackerOrigin}/i13.png` }),
                ] },
                { type: 2, tagName: "body", attributes: {}, id: 4, childNodes: [{ type: 3, textContent: "hello", id: 5 }] },
              ],
            }],
          },
        },
      },
      {
        type: 3, timestamp: 1300,
        data: {
          source: 0, texts: [], removes: [], adds: [],
          attributes: [
            { id: 10, attributes: { href: `${attackerOrigin}/p10-late` } },
            { id: 11, attributes: { imagesrcset: `${attackerOrigin}/p11-set.png 1x`, rel: "preload" } },
            { id: 12, attributes: { rel: "prerender" } },
            { id: 13, attributes: { rel: "preconnect" } },
          ],
        },
      },
      { type: 3, timestamp: 1400, data: { source: 3, id: 4, x: 0, y: 10 } },
    ];

    await withOptionsPage(async (page, origin) => {
      await seedAndReload(page, origin, { events: { 11: events } });
      await waitFor(page, `document.querySelectorAll("#sessions-body tr").length === 1`);
      await page.evaluate(`document.querySelector("#sessions-body tr td button").click()`);
      await waitFor(page, `!!document.querySelector("#player-container iframe")`);
      await page.evaluate(`currentPlayer.play()`); // applies the mutation in real time, as a viewer watching would
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const linkCount = await page.evaluate(`document.querySelector("#player-container iframe").contentDocument.querySelectorAll("link").length`);
      assert.equal(linkCount, 4, "every recorded link node must stay in the replay");
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(state.count, 0, `expected 0 requests to the attacker-like server, got ${state.count}`);
    assert.equal(state.connections, 0, `expected 0 connections to the attacker-like server, got ${state.connections}`);
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
    await clickByLabel(page, "keepme-app");
    await waitFor(page, `!!document.querySelector(".rr-player")`);

    // Delete "pruned" from under the page (simulates the hourly audit-prune alarm).
    await page.evaluate(`AuditStore.deleteSession("pruned")`);

    // Click the now-stale "pruned" row.
    await clickByLabel(page, "pruned-app");
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

// Item 5: age-based pruning (or a batch dropped before it was ever stored)
// can leave a tab's stream with no FullSnapshot to replay from — including
// old recordings stored before store.js's own prune fix (item 6) closed this
// for new ones. The generic "Replay unavailable for this tab." (the catch
// block below) is for a player construction failure, not this case.
test("a tab with no FullSnapshot in its stored events shows the retention notice, not the generic one (item 5)", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withOptionsPage(async (page, origin) => {
    await seedAndReload(page, origin, { events: { 11: [FIXTURE_EVENTS[2]] } }); // only the ts:2000 incremental event
    await waitFor(page, `document.querySelectorAll("#sessions-body tr").length === 1`);

    await page.evaluate(`document.querySelector("#sessions-body tr td button").click()`);
    await waitFor(page, `document.querySelectorAll("#actions-body tr").length === 2`);
    await waitFor(page, `document.getElementById("player-notice").hidden === false`);

    const notice = await page.evaluate(`document.getElementById("player-notice").textContent`);
    assert.equal(notice, "Replay unavailable: the start of this recording was deleted by retention.");
    assert.equal(await page.evaluate(`!!document.querySelector(".rr-player")`), false);
  });
});

test("while a slow session load is in flight, Delete/Export are unbound instead of pointing at the previous session (N3)", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withOptionsPage(async (page, origin) => {
    await seedTwoSessions(page, origin);

    await clickByLabel(page, "session-a");
    await waitFor(page, `document.getElementById("session-detail").hidden === false`);

    await page.evaluate(`(() => {
      const real = AuditStore.getSession;
      AuditStore.getSession = (id) => new Promise((resolve) => setTimeout(() => resolve(real(id)), 400));
    })()`);
    await clickByLabel(page, "session-b");

    // Immediately: session-a's detail is gone, and Delete/Export are unbound —
    // neither can act on it (nor on session-b, which hasn't loaded yet).
    assert.equal(await page.evaluate(`document.getElementById("session-detail").hidden`), true);
    assert.equal(await page.evaluate(`document.getElementById("delete-session").onclick`), null);
    assert.equal(await page.evaluate(`document.getElementById("export-session").onclick`), null);

    await waitFor(page, `document.getElementById("session-detail").hidden === false`, { timeout: 3000 });
    const actionTool = await page.evaluate(`document.querySelectorAll("#actions-body tr td")[1]?.textContent`);
    assert.equal(actionTool, "computer"); // session-b's own action, not a leftover from session-a's "navigate"
  });
});

test("a rejecting session load shows a notice instead of leaving Delete/Export bound to the previous session (N3)", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withOptionsPage(async (page, origin) => {
    await seedTwoSessions(page, origin);

    await clickByLabel(page, "session-a");
    await waitFor(page, `document.getElementById("session-detail").hidden === false`);

    // Rejects only the first call for "sessB" (the detail-open call itself),
    // so renderSessions()'s own per-row getSession calls afterward still work.
    await page.evaluate(`(() => {
      const real = AuditStore.getSession;
      let rejectedOnce = false;
      AuditStore.getSession = (id) => {
        if (id === "sessB" && !rejectedOnce) { rejectedOnce = true; return Promise.reject(new Error("boom")); }
        return real(id);
      };
    })()`);
    await clickByLabel(page, "session-b");

    await waitFor(page, `document.getElementById("session-detail").hidden === true`);
    await waitFor(page, `document.getElementById("sessions-notice").hidden === false`);
    assert.equal(await page.evaluate(`document.getElementById("delete-session").onclick`), null);
    assert.equal(await page.evaluate(`document.getElementById("export-session").onclick`), null);

    const stillA = await page.evaluate(`AuditStore.getSession("sessA")`);
    assert.equal(stillA.session.id, "sessA");
  });
});

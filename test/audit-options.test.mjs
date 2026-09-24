// Exercises extension/options.html + options.js against real Chrome: the audit
// settings checkbox/select, the sessions table, session detail (actions + rrweb
// replay), JSON export, and delete. IndexedDB needs a real origin, so extension/
// is served from a local http server (same pattern as audit-store.test.mjs).
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

// A hand-made (not captured) rrweb event stream: a Meta event and a FullSnapshot
// of a tiny DOM, plus one incremental event so the replay has a non-zero
// duration to seek within. No real page or secrets involved.
const FIXTURE_EVENTS = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "fixtures", "rrweb-events.hand-made.json"), "utf8"),
);

const SESSION = { id: "s1", label: "myapp", cwd: "/Users/x/app", pid: 4242 };
const ACTION_1 = { sessionId: "s1", ts: 1200, tool: "navigate", tabId: 11, summary: "https://example.test/", outcome: "ok", ms: 12 };
const ACTION_2 = { sessionId: "s1", ts: 1800, tool: "computer", tabId: 11, summary: "left_click at (10, 20)", outcome: "ok", ms: 5 };

// Installed via Page.addScriptToEvaluateOnNewDocument, before the real page
// scripts run. Backs chrome.storage.local with an in-memory object exposed as
// window.__storageState so tests can assert on what options.js wrote.
const STORAGE_STUB = `(() => {
  const state = {};
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

async function waitFor(page, expr, { timeout = 5000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(expr)) return;
    if (Date.now() > deadline) throw new Error(`waitFor timed out waiting for: ${expr}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

// Repeats `actionExpr` (not just waits) until `predicateExpr` is true: options.js
// attaches its listeners asynchronously (after AuditStore.open() resolves), so a
// single dispatch right after navigation can race ahead of that and be lost.
// Re-dispatching is harmless (setting .checked to the same value twice is a no-op).
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
async function withOptionsPage(fn) {
  const server = serveExtension();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  try {
    const page = await openPage(browser);
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: STORAGE_STUB });
    await navigate(page, `${origin}/options.html`);
    await fn(page, origin);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Seeds the DB through the page's own (already-loaded) AuditStore, then reloads
// options.html so its init() renders against the now-populated IndexedDB —
// avoids racing the first load's own (empty-DB) render.
async function seedAndReload(page, origin) {
  await page.evaluate(`AuditStore.open()`);
  await page.evaluate(`AuditStore.upsertSession(${JSON.stringify(SESSION)}, 1000)`);
  await page.evaluate(`AuditStore.addAction(${JSON.stringify(ACTION_1)})`);
  await page.evaluate(`AuditStore.addAction(${JSON.stringify(ACTION_2)})`);
  await page.evaluate(`AuditStore.addEvents("s1", 11, ${JSON.stringify(FIXTURE_EVENTS)})`);
  await navigate(page, `${origin}/options.html`);
}

let browser;
before(async () => { if (chromeAvailable) browser = await launchChrome(); }, { timeout: 30000 });
after(() => browser?.close());

test("ticking the audit checkbox writes enabled + retentionDays to chrome.storage.local", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withOptionsPage(async (page) => {
    await retryUntil(
      page,
      `(() => {
        const cb = document.getElementById("audit-enabled");
        cb.checked = true;
        cb.dispatchEvent(new Event("change"));
      })()`,
      `window.__storageState.audit != null`,
    );
    const audit = await page.evaluate("window.__storageState.audit");
    assert.deepEqual(audit, { enabled: true, retentionDays: 7 });
  });
});

test("sessions table, session detail with replay, export, and delete", { skip: !chromeAvailable, timeout: 20000 }, async () => {
  await withOptionsPage(async (page, origin) => {
    await seedAndReload(page, origin);
    await waitFor(page, `document.querySelectorAll("#sessions-body tr").length === 1`);

    const label = await page.evaluate(`document.querySelector("#sessions-body tr td").textContent`);
    assert.equal(label, "myapp");

    await page.evaluate(`document.querySelector("#sessions-body tr").click()`);
    await waitFor(page, `document.querySelectorAll("#actions-body tr").length === 2`);
    await waitFor(page, `!!document.querySelector(".rr-player")`);

    const exportedText = await page.evaluate(`(async () => {
      const a = document.getElementById("export-session");
      const res = await fetch(a.href);
      return res.text();
    })()`);
    const exported = JSON.parse(exportedText);
    assert.equal(exported.session.id, "s1");

    await page.evaluate(`document.getElementById("delete-session").click()`);
    await waitFor(page, `document.querySelectorAll("#sessions-body tr").length === 0`);

    const remaining = await page.evaluate(`AuditStore.listSessions()`);
    assert.equal(remaining.length, 0);
  });
});

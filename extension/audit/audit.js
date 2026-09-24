// Wraps tool handlers with a best-effort, redacted audit trail. Off by default;
// only the extension's own options page flips chrome.storage.local's "audit" key
// (Task 17). No handler here ever changes a tool's own result or error: every
// store call is caught and logged, never rethrown to the caller.
//
// Settings are re-read on every call rather than cached, so a toggle from the
// options page takes effect immediately without a service worker restart. And
// as long as audit is disabled, nothing here ever calls into AuditStore — so the
// "ocic-audit" IndexedDB database is not even created until the user opts in.

const AUDIT_PRUNE_ALARM = "audit-prune";
const AUDIT_MAX_SESSIONS = 200;

let store = null;
const tabOwners = new Map(); // tabId -> sessionId, the last session to act on that tab

async function settings() {
  const { audit } = await chrome.storage.local.get("audit");
  return { enabled: false, retentionDays: 7, ...audit };
}

async function runPrune() {
  try {
    const { enabled, retentionDays } = await settings();
    if (!enabled) return;
    await store.open();
    await store.prune({ retentionDays, maxSessions: AUDIT_MAX_SESSIONS, now: Date.now() });
  } catch (err) {
    console.error("[audit] prune failed:", err);
  }
}

function init({ store: injected = AuditStore } = {}) {
  store = injected;
  runPrune();
  chrome.alarms.create(AUDIT_PRUNE_ALARM, { periodInMinutes: 60 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === AUDIT_PRUNE_ALARM) runPrune();
  });
}

async function recordAction(tool, args, ctx, outcome, ms) {
  const { enabled } = await settings();
  if (!enabled) return;
  const session = ctx && ctx.session;
  if (!session) return; // unattributed request: record nothing

  const tabId = args && args.tabId != null ? args.tabId : null;
  if (tabId != null) tabOwners.set(tabId, session.id);

  const ts = Date.now();
  await store.open();
  await store.upsertSession(session, ts);
  await store.addAction({ sessionId: session.id, ts, tool, tabId, summary: auditSummary(tool, args), outcome, ms });
}

async function safeRecord(tool, args, ctx, outcome, ms) {
  try {
    await recordAction(tool, args, ctx, outcome, ms);
  } catch (err) {
    console.error("[audit] failed to record action:", err);
  }
}

function wrapHandlers(handlers) {
  for (const name of Object.keys(handlers)) {
    const original = handlers[name];
    handlers[name] = async function auditWrapped(args, ctx) {
      const started = Date.now();
      let result;
      try {
        result = await original(args, ctx);
      } catch (err) {
        await safeRecord(name, args, ctx, `error: ${err.message}`, Date.now() - started);
        throw err;
      }
      await safeRecord(name, args, ctx, "ok", Date.now() - started);
      return result;
    };
  }
  return handlers;
}

async function onRecorderEvents(tabId, events) {
  try {
    const { enabled } = await settings();
    if (!enabled) return;
    const sessionId = tabOwners.get(tabId);
    if (!sessionId) return; // no owner for this tab: drop
    await store.open();
    await store.addEvents(sessionId, tabId, events || []);
  } catch (err) {
    console.error("[audit] failed to record recorder events:", err);
  }
}

globalThis.Audit = { init, wrapHandlers, onRecorderEvents, settings };

// Wraps tool handlers with a best-effort, redacted audit trail. Off by default;
// only the extension's own options page flips chrome.storage.local's "audit" key
// (Task 17). No handler here ever changes a tool's own result or error: every
// store call is caught and logged, never rethrown to the caller.
//
// Settings are re-read on every call rather than cached, so a toggle from the
// options page takes effect immediately without a service worker restart.
// Classic script, loaded via importScripts; defines only globalThis.Audit
// (wrapped in an IIFE so its many helpers can't collide with anything else in
// the shared worker scope — see store.js for the same reasoning).

(() => {
  const AUDIT_PRUNE_ALARM = "audit-prune";
  const AUDIT_MAX_SESSIONS = 200;
  const AUDIT_ERROR_CLIP = 200;
  const ENSURE_RECORDER_PROBE_TIMEOUT_MS = 300;
  const ENSURE_RECORDER_INJECT_TIMEOUT_MS = 2000;
  const RECENT_OWNER_WINDOW_MS = 10000;
  const OWNER_ROW_RETRY_DELAY_MS = 500;

  let store = null;
  // I5 (plan-mandated): which tabs may be recorded at all, e.g. background's own
  // isInGroup. Defaults to "every tab", so callers that don't pass one (existing
  // tests, and any future caller) keep today's behaviour.
  let isTabAllowed = async () => true;
  const tabOwners = new Map(); // tabId -> "<runId>.<session.id>", the last session to act on that tab
  const tabOwnerSetAt = new Map(); // tabId -> Date.now() when tabOwners was last set, for the retry below
  const knownTagsByTab = new Map(); // tabId -> Map(rrweb node id -> lowercase tagName), for redactEvents (I1)
  const failedRecorderStarts = new Map(); // tabId -> the tab's url when a recorder start last failed there, for item 16

  async function settings() {
    const { audit } = await chrome.storage.local.get("audit");
    const enabled = !!(audit && audit.enabled);
    // M7: a raw <select> value ("7") or a cleared field (undefined) must not
    // silently disable age pruning — fall back to the 7-day default instead.
    const rd = Number(audit && audit.retentionDays);
    const retentionDays = Number.isFinite(rd) && rd > 0 ? rd : 7;
    return { enabled, retentionDays };
  }

  // I2: the hub numbers sessions from s1 again in every process (bridge-hub.js's
  // counter resets on restart), so session.id alone is not a stable identity.
  // ctx.requestId is "<runId>.<session>.<clientId>" and runId is 8 random hex
  // characters per hub process, so "<runId>.<session.id>" never collides
  // across a restart the way session.id alone does.
  function sessionKey(ctx) {
    const session = ctx && ctx.session;
    if (!session || !session.id) return null;
    const runId = String(ctx.requestId).split(".")[0];
    return `${runId}.${session.id}`;
  }

  // I3: prune whenever the "audit" key exists at all (enabled or not), so data
  // recorded while it was on still gets cleaned up after the user switches it
  // off. Only skip when the key is absent entirely — no opt-in yet means no
  // database, and it keeps the vm tests (no storage at all) quiet.
  async function runPrune() {
    try {
      const { audit } = await chrome.storage.local.get("audit");
      if (!audit) return;
      const { retentionDays } = await settings();
      await store.open();
      await store.prune({ retentionDays, maxSessions: AUDIT_MAX_SESSIONS, now: Date.now() });
    } catch (err) {
      console.error("[audit] prune failed:", err);
    }
  }

  function init({ store: injected = AuditStore, isTabAllowed: allowed } = {}) {
    store = injected;
    if (allowed) isTabAllowed = allowed;
    runPrune();
    chrome.alarms.create(AUDIT_PRUNE_ALARM, { periodInMinutes: 60 });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === AUDIT_PRUNE_ALARM) runPrune();
    });
    // New Minor 3 (fix round 2): tabOwners, tabOwnerSetAt and knownTagsByTab
    // otherwise grow for as long as the worker stays alive — knownTagsByTab in
    // particular holds one entry per element, tens of thousands on a large page.
    chrome.tabs.onRemoved.addListener((tabId) => {
      tabOwners.delete(tabId);
      tabOwnerSetAt.delete(tabId);
      knownTagsByTab.delete(tabId);
      failedRecorderStarts.delete(tabId);
    });
    // Item 16: a failed start is remembered only for the document it failed
    // on (see ensureRecorder) — a navigation (or an in-page URL change) means
    // a fresh document that deserves its own attempt, so drop the memory of
    // the old one rather than wait for its url to happen to differ.
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (changeInfo.status === "loading" || changeInfo.url) failedRecorderStarts.delete(tabId);
    });
  }

  async function recordAction(tool, args, ctx, outcome, ms) {
    const { enabled } = await settings();
    if (!enabled) return;
    const key = sessionKey(ctx);
    if (!key) return; // unattributed request: record nothing
    const session = ctx.session;
    const tabId = args && args.tabId != null ? args.tabId : null;

    const ts = Date.now();
    await store.open();
    await store.upsertSession({ id: key, label: session.label, cwd: session.cwd, pid: session.pid }, ts);
    await store.addAction({ sessionId: key, ts, tool, tabId, summary: auditSummary(tool, args), outcome, ms });
  }

  async function safeRecord(tool, args, ctx, outcome, ms) {
    try {
      await recordAction(tool, args, ctx, outcome, ms);
    } catch (err) {
      console.error("[audit] failed to record action:", err);
    }
  }

  // Upserts the session row as soon as a call starts (not just when it finishes
  // recording, in recordAction) so that a session's very first-ever action has
  // a row to find almost immediately — closing most of the window in which
  // onRecorderEvents' hasSession check (I4) could otherwise mistake "not
  // created yet" for "deleted". Fire-and-forget, same reasoning as M2.
  async function touchSession(key, session) {
    try {
      const { enabled } = await settings();
      if (!enabled) return;
      await store.open();
      await store.upsertSession({ id: key, label: session.label, cwd: session.cwd, pid: session.pid }, Date.now());
    } catch (err) {
      console.error("[audit] failed to record session:", err);
    }
  }

  // Rejects with a timeout error if `promise` hasn't settled within `ms`, without
  // cancelling the underlying operation (there is no way to cancel a real
  // chrome.scripting.executeScript call). A late resolution/rejection after the
  // timeout has already fired is just ignored (a promise only settles once).
  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }

  // Makes sure the tab has a running rrweb recorder (Task 16), injecting
  // vendor/rrweb-record.min.js and audit/recorder.js only when one isn't already there.
  // No-op while audit is off. Errors (a chrome:// tab, a tab that just closed, or
  // I4's own timeout below) are swallowed: recording is best-effort and must
  // never break the action it wraps.
  //
  // I4: a page stuck on an open JS dialog (or one that hasn't reached the
  // default document_idle injection point) never answers
  // chrome.scripting.executeScript, so both calls race a short timeout instead
  // of awaiting it unbounded — matching background.js's own rule for renderer
  // round-trips (readViewport, focusedFieldKind, resize_window all bound theirs
  // the same way, for the same reason).
  //
  // Item 16: a chrome:// page, the Web Store, or any other page that refuses
  // injection outright would otherwise pay this same probe+inject timeout
  // budget on every audited call to that tab (before AND after, per
  // wrapHandlers below) for as long as it stays on that document. Remembers
  // a failed start keyed by the tab's own url, and skips straight past both
  // attempts while the tab is still showing the document that failed —
  // chrome.tabs.onUpdated (init, above) forgets it on the next navigation.
  async function ensureRecorder(tabId) {
    let tab;
    try {
      const { enabled } = await settings();
      if (!enabled) return;
      tab = await chrome.tabs.get(tabId);
      if (failedRecorderStarts.get(tabId) === tab.url) return;
      const [check] = await withTimeout(
        chrome.scripting.executeScript({
          target: { tabId },
          world: "ISOLATED",
          func: () => !!globalThis[Symbol.for("ocic.audit.recorder")],
        }),
        ENSURE_RECORDER_PROBE_TIMEOUT_MS,
      );
      if (check?.result) { failedRecorderStarts.delete(tabId); return; }
      await withTimeout(
        chrome.scripting.executeScript({
          target: { tabId },
          world: "ISOLATED",
          files: ["vendor/rrweb-record.min.js", "audit/recorder.js"],
        }),
        ENSURE_RECORDER_INJECT_TIMEOUT_MS,
      );
      failedRecorderStarts.delete(tabId);
    } catch {
      // Best-effort only; see comment above. `tab` is unset only when
      // settings()/chrome.tabs.get() itself is what failed (a tab that
      // closed mid-call, for example) — nothing to key a cache entry on.
      if (tab) failedRecorderStarts.set(tabId, tab.url);
    }
  }

  function wrapHandlers(handlers) {
    for (const name of Object.keys(handlers)) {
      const original = handlers[name];
      handlers[name] = async function auditWrapped(args, ctx) {
        const tabId = args && args.tabId != null ? args.tabId : null;
        const key = sessionKey(ctx);
        // I5 (plan-mandated): a tabId the tool itself would refuse (outside the
        // MCP group) must not get a recorder or become that tab's owner — some
        // handlers (gif_creator and other stubs) have no group check of their
        // own to piggyback on, so this is checked independently here.
        const allowed = tabId != null && (await isTabAllowed(tabId));
        // M1: before the call (not after recordAction, which used to run only
        // once the whole handler had already returned) — otherwise a recorder
        // batch that arrives mid-call, or from a different session reusing a
        // tab another session last owned, finds no owner yet, or the wrong one.
        if (allowed && key) { tabOwners.set(tabId, key); tabOwnerSetAt.set(tabId, Date.now()); }
        if (key) touchSession(key, ctx.session);
        if (allowed) await ensureRecorder(tabId);
        const started = Date.now();
        let result;
        try {
          result = await original(args, ctx);
        } catch (err) {
          // M1: computed before the after-hook below, which — per I4 — is not
          // awaited, so a slow or timed-out ensureRecorder call never inflates
          // the tool's own recorded duration.
          const ms = Date.now() - started;
          if (allowed) ensureRecorder(tabId);
          // M2: fire-and-forget — safeRecord never rejects (its own try/catch
          // guarantees that), and a stalled store write must never delay the
          // tool's actual response to the host.
          safeRecord(name, args, ctx, `error: ${scrubUrls(String(err.message), AUDIT_ERROR_CLIP)}`, ms);
          throw err;
        }
        const ms = Date.now() - started;
        if (allowed) ensureRecorder(tabId);
        safeRecord(name, args, ctx, "ok", ms);
        return result;
      };
    }
    return handlers;
  }

  // New Minor 2 (fix round 2): the owner is set synchronously in wrapHandlers,
  // but touchSession's row write is fire-and-forget and can still be in
  // flight. A batch landing in that narrow window used to fail hasSession, get
  // dropped, and delete the tab's owner — dropping every later batch for that
  // tab too (including a new document's full snapshot after a navigate).
  // Retried once, half a second later, but only when the owner was set
  // recently: a row that is still missing long after ownership was set really
  // is gone (pruned, or deleted from the options page), not just delayed.
  async function hasSessionWithRetry(tabId, key) {
    if (await store.hasSession(key)) return true;
    const setAt = tabOwnerSetAt.get(tabId);
    if (setAt == null || Date.now() - setAt >= RECENT_OWNER_WINDOW_MS) return false;
    await new Promise((resolve) => setTimeout(resolve, OWNER_ROW_RETRY_DELAY_MS));
    return store.hasSession(key);
  }

  async function onRecorderEvents(tabId, events) {
    try {
      const { enabled } = await settings();
      if (!enabled) return;
      const key = tabOwners.get(tabId);
      if (!key) return; // no owner for this tab: drop
      // Item 9: a tab's recorder keeps running (and keeps sending batches)
      // after the tab itself leaves the MCP group — nothing tells the
      // content script to stop. Re-check the same gate wrapHandlers used to
      // grant ownership in the first place, and clear the stale owner rather
      // than merely gating this one batch: if the tab later rejoins the
      // group with no new audited call, a batch for it must still be
      // dropped, not resumed under whichever session owned it before.
      if (!(await isTabAllowed(tabId))) { tabOwners.delete(tabId); tabOwnerSetAt.delete(tabId); return; }
      await store.open();
      // I4: the owning session's row may be gone (pruned, or deleted from the
      // options page) even though the in-memory tab-ownership map still
      // remembers it — don't resurrect an orphan row, and forget the mapping
      // so it isn't rechecked on every future batch for this tab.
      if (!(await hasSessionWithRetry(tabId, key))) { tabOwners.delete(tabId); return; }
      // I1/I2: redact hidden-input/cleared-value leftovers and URL-bearing
      // attributes before they are ever written to disk, in the worker, so a
      // recorder in any document cannot bypass it. knownTags is kept per tab
      // across batches — see redact.js's redactEvents for why.
      let knownTags = knownTagsByTab.get(tabId);
      if (!knownTags) { knownTags = new Map(); knownTagsByTab.set(tabId, knownTags); }
      await store.addEvents(key, tabId, redactEvents(events || [], knownTags));
    } catch (err) {
      console.error("[audit] failed to record recorder events:", err);
    }
  }

  globalThis.Audit = { init, wrapHandlers, onRecorderEvents, settings };
})();

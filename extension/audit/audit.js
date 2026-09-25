// Wraps tool handlers with a best-effort, redacted audit trail. Off by default;
// only the extension's own options page flips chrome.storage.local's "audit" key.
// No handler here ever changes a tool's own result or error: every store call
// is caught and logged, never rethrown to the caller.
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
  // Which tabs may be recorded at all. background.js passes a predicate that
  // allows a tab in the MCP group that shows no blocked page (a local file or
  // this extension's own page) and ignores an open JS dialog, so a dialog never
  // stops a recording. Defaults to "every tab", so callers that don't pass one
  // (existing tests, and any future caller) keep today's behaviour.
  let isTabAllowed = async () => true;
  const auditTexts = new WeakMap(); // result or error background.js marked as holding no tool input -> a text to store instead, or null for its own
  const tabOwners = new Map(); // tabId -> "<runId>.<session.id>", the last session to act on that tab
  const tabOwnerSetAt = new Map(); // tabId -> Date.now() when tabOwners was last set, for the retry below
  const knownTagsByTab = new Map(); // tabId -> Map(rrweb node id -> lowercase tagName, or a text node's marker), for redactEvents
  const failedRecorderStarts = new Map(); // tabId -> the tab's url when Chrome last refused to script it
  // Chrome's wording when it refuses to script a page at all: chrome:// and
  // other browser pages, the Web Store, a host without permission. That holds
  // for as long as the tab shows the document. A timeout or any other failure
  // can be temporary (a page busy in a long task, or not yet at document_idle).
  const PERMANENT_SCRIPTING_ERROR = /cannot be scripted|cannot access|permission/i;

  async function settings() {
    const { audit } = await chrome.storage.local.get("audit");
    const enabled = !!(audit && audit.enabled);
    // A raw <select> value ("7") or a cleared field (undefined) must not
    // silently disable age pruning — fall back to the 7-day default instead.
    const rd = Number(audit && audit.retentionDays);
    const retentionDays = Number.isFinite(rd) && rd > 0 ? rd : 7;
    return { enabled, retentionDays };
  }

  // The hub numbers sessions from s1 again in every process (bridge-hub.js's
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

  // Prune whenever the "audit" key exists at all (enabled or not), so data
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
    // tabOwners, tabOwnerSetAt and knownTagsByTab otherwise grow for as long as
    // the worker stays alive — knownTagsByTab in particular holds one entry per
    // element and text node, tens of thousands on a large page.
    chrome.tabs.onRemoved.addListener((tabId) => {
      tabOwners.delete(tabId);
      tabOwnerSetAt.delete(tabId);
      knownTagsByTab.delete(tabId);
      failedRecorderStarts.delete(tabId);
    });
    // A refused start is remembered only for the document it failed on (see
    // ensureRecorder) — a navigation (or an in-page URL change) means a fresh
    // document that deserves its own attempt, so drop the memory of the old
    // one rather than wait for its url to happen to differ.
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
  // onRecorderEvents' hasSession check could otherwise mistake "not created
  // yet" for "deleted". Fire-and-forget, for the same reason as safeRecord in
  // wrapHandlers: a stalled store write must never delay a tool's response.
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

  // Makes sure the tab has a running rrweb recorder, injecting
  // vendor/rrweb-record.min.js and audit/recorder.js only when one isn't already there.
  // No-op while audit is off. Errors (a chrome:// tab, a tab that just closed, or
  // the timeout below) are swallowed: recording is best-effort and must
  // never break the action it wraps.
  //
  // A page stuck on an open JS dialog (or one that hasn't reached the
  // default document_idle injection point) never answers
  // chrome.scripting.executeScript, so both calls race a short timeout instead
  // of awaiting it unbounded — matching background.js's own rule for renderer
  // round-trips (readViewport, focusedFieldKind, resize_window all bound theirs
  // the same way, for the same reason).
  //
  // A chrome:// page, the Web Store, or any other page that refuses injection
  // outright would otherwise pay this same probe+inject budget on every
  // audited call to that tab (before AND after, per wrapHandlers below) for as
  // long as it stays on that document. Remembers such a refusal keyed by the
  // tab's own url, and skips straight past both attempts while the tab is
  // still showing that document — chrome.tabs.onUpdated (init, above) forgets
  // it on the next navigation. Only a refusal is remembered: a timeout or a
  // transient error can come after that document's last onUpdated event, so
  // remembering it would leave the document without a recorder for good.
  //
  // `snapshot` asks a recorder already running in the tab for a fresh
  // FullSnapshot, for a new owner's stream (see wrapHandlers). A recorder
  // injected here takes its own first snapshot anyway.
  async function ensureRecorder(tabId, snapshot = false) {
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
          // Runs in the page, so it can use nothing from this file's scope.
          func: (takeSnapshot) => {
            const recorder = globalThis[Symbol.for("ocic.audit.recorder")];
            if (recorder && takeSnapshot && typeof recorder.takeFullSnapshot === "function") recorder.takeFullSnapshot();
            return !!recorder;
          },
          args: [snapshot],
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
    } catch (err) {
      // Best-effort only; see comment above. `tab` is unset only when
      // settings()/chrome.tabs.get() itself is what failed (a tab that
      // closed mid-call, for example) — nothing to key a cache entry on.
      if (tab && PERMANENT_SCRIPTING_ERROR.test(String(err && err.message))) failedRecorderStarts.set(tabId, tab.url);
    }
  }

  function wrapHandlers(handlers) {
    for (const name of Object.keys(handlers)) {
      const original = handlers[name];
      handlers[name] = async function auditWrapped(args, ctx) {
        const tabId = args && args.tabId != null ? args.tabId : null;
        const key = sessionKey(ctx);
        // A tabId the tool itself would refuse (outside the MCP group) must not
        // get a recorder or become that tab's owner — some handlers
        // (gif_creator and other stubs) have no group check of their own to
        // piggyback on, so this is checked independently here.
        const allowed = tabId != null && (await isTabAllowed(tabId));
        // A stream stored under a new owner needs a FullSnapshot of its own:
        // the recorder already running in the tab took its snapshot for the
        // previous owner, or before a gap in which no one owned the tab and
        // its batches were dropped.
        const newOwner = allowed && key != null && tabOwners.get(tabId) !== key;
        // Before the call (not after recordAction, which used to run only
        // once the whole handler had already returned) — otherwise a recorder
        // batch that arrives mid-call, or from a different session reusing a
        // tab another session last owned, finds no owner yet, or the wrong one.
        if (allowed && key) { tabOwners.set(tabId, key); tabOwnerSetAt.set(tabId, Date.now()); }
        if (key) touchSession(key, ctx.session);
        if (allowed) await ensureRecorder(tabId, newOwner);
        const started = Date.now();
        let result;
        try {
          result = await original(args, ctx);
        } catch (err) {
          // Computed before the after-hook below, which is not awaited (see
          // ensureRecorder), so a slow or timed-out ensureRecorder call never
          // inflates the tool's own recorded duration.
          const ms = Date.now() - started;
          if (allowed) ensureRecorderIfAllowed(tabId);
          // Fire-and-forget — safeRecord never rejects (its own try/catch
          // guarantees that), and a stalled store write must never delay the
          // tool's actual response to the host.
          safeRecord(name, args, ctx, errorOutcome(name, args, String(err.message), err), ms);
          throw err;
        }
        const ms = Date.now() - started;
        if (allowed) ensureRecorderIfAllowed(tabId);
        const outcome = result && result.isError === true ? errorOutcome(name, args, errorResultText(result), result) : "ok";
        safeRecord(name, args, ctx, outcome, ms);
        return result;
      };
    }
    return handlers;
  }

  // The after-hook. The tab can have left the MCP group during the call, and
  // then it gets no recorder probe or injection.
  async function ensureRecorderIfAllowed(tabId) {
    try {
      if (await isTabAllowed(tabId)) await ensureRecorder(tabId);
    } catch (err) {
      console.error("[audit] after-call recorder check failed:", err);
    }
  }

  // A refusal or a failure comes back as a result with isError, not a throw.
  // Its last text block says what failed (a browser_batch lists the actions it
  // ran before the line naming the one that failed).
  function errorResultText(result) {
    const texts = (Array.isArray(result.content) ? result.content : []).filter((c) => c && c.type === "text" && typeof c.text === "string");
    return texts.length > 0 ? texts[texts.length - 1].text : "";
  }

  // The stored outcome of a failed call. An error text can quote the call's
  // input (a select miss quotes the form value, an unparseable URL keeps its
  // query after a space, a V8 message quotes a string literal), so for a call
  // whose summary hides input (summaryHidesInput) the text is stored only when
  // background.js marked it as holding none: the shared refusals, fixed texts,
  // and timeout, dialog and transport failures. A text that quotes page text
  // the call can produce (a JavaScript dialog's message) is marked with a fixed
  // text to store instead, for every tool. The reply itself is unchanged.
  function errorOutcome(tool, args, text, source) {
    const stored = auditTextFor(source, text);
    if (stored !== null) return `error: ${scrubUrls(stored, AUDIT_ERROR_CLIP)}`;
    if (summaryHidesInput(tool, args)) return "error (text withheld)";
    return `error: ${scrubUrls(text, AUDIT_ERROR_CLIP)}`;
  }

  // Marks a tool result or a thrown error whose text holds no tool input, so
  // errorOutcome may store it, or store auditText instead when one is given.
  // An earlier mark is kept, so an error re-thrown through another marking
  // layer keeps its fixed text. Returns what it was given.
  function markInputFree(resultOrError, auditText = null) {
    if (resultOrError && typeof resultOrError === "object" && !auditTexts.has(resultOrError)) auditTexts.set(resultOrError, auditText);
    return resultOrError;
  }

  // What errorOutcome may store for a marked result or error: its fixed text,
  // or ownText. null when it is not marked.
  function auditTextFor(resultOrError, ownText) {
    if (!auditTexts.has(resultOrError)) return null;
    const fixed = auditTexts.get(resultOrError);
    return fixed === null ? ownText : fixed;
  }

  // The owner is set synchronously in wrapHandlers,
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
      // A tab's recorder keeps running (and keeps sending batches) after the
      // tab itself leaves the MCP group — nothing tells the content script to
      // stop. Re-check the same gate wrapHandlers used to grant ownership in
      // the first place, and clear the stale owner rather than merely gating
      // this one batch: if the tab later rejoins the group with no new
      // audited call, a batch for it must still be dropped, not resumed under
      // whichever session owned it before.
      if (!(await isTabAllowed(tabId))) { tabOwners.delete(tabId); tabOwnerSetAt.delete(tabId); return; }
      await store.open();
      // The owning session's row may be gone (pruned, or deleted from the
      // options page) even though the in-memory tab-ownership map still
      // remembers it — don't resurrect an orphan row, and forget the mapping
      // so it isn't rechecked on every future batch for this tab.
      if (!(await hasSessionWithRetry(tabId, key))) { tabOwners.delete(tabId); return; }
      // Redact hidden-input/cleared-value leftovers and URL-bearing
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

  // A tab that left the MCP group keeps its recorder running, but its batches
  // are dropped from now on: an owner comes back only with the next audited
  // call on that tab.
  function dropOwner(tabId) {
    tabOwners.delete(tabId);
    tabOwnerSetAt.delete(tabId);
  }

  globalThis.Audit = { init, wrapHandlers, onRecorderEvents, settings, dropOwner, markInputFree, auditTextFor };
})();

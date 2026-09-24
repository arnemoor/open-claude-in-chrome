// Options page: the audit mode switch and the session/replay viewer. Classic
// script (MV3 extension pages forbid inline script and eval). Reads and writes
// chrome.storage.local's "audit" key in the same shape Task 15's Audit.settings()
// reads ({ enabled, retentionDays }), and talks to the audit log only through
// AuditStore (extension/audit/store.js, loaded before this file).

const DEFAULT_SETTINGS = { enabled: false, retentionDays: 7 };
const VALID_RETENTIONS = [1, 7, 30];

const enabledCheckbox = document.getElementById("audit-enabled");
const retentionSelect = document.getElementById("audit-retention");
const sessionsBody = document.getElementById("sessions-body");
const sessionsEmpty = document.getElementById("sessions-empty");
const sessionsNotice = document.getElementById("sessions-notice");
const detailSection = document.getElementById("session-detail");
const actionsBody = document.getElementById("actions-body");
const tabSelect = document.getElementById("tab-select");
const playerContainer = document.getElementById("player-container");
const playerNotice = document.getElementById("player-notice");
const deleteButton = document.getElementById("delete-session");
const exportLink = document.getElementById("export-session");

let currentSession = null; // { session, actions, eventsByTab } for the open detail panel
let currentPlayer = null;
let exportUrl = null;

function td(text) {
  const cell = document.createElement("td");
  cell.textContent = text;
  return cell;
}

// The label cell holds a real <button>, not just a click handler on the <tr>,
// so keyboard users can reach and open a session too (M8).
function labelCell(session) {
  const cell = document.createElement("td");
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = session.label;
  button.addEventListener("click", () => showSessionDetail(session.id));
  cell.appendChild(button);
  return cell;
}

function formatTime(ts) {
  return new Date(ts).toLocaleString();
}

function showNotice(text) {
  sessionsNotice.textContent = text;
  sessionsNotice.hidden = false;
}

function clearNotice() {
  sessionsNotice.hidden = true;
}

function showPlayerNotice(text) {
  playerNotice.textContent = text;
  playerNotice.hidden = false;
}

function clearPlayerNotice() {
  playerNotice.hidden = true;
}

// --- Audit settings ---
// Wired before AuditStore is ever opened (see init()), so the switch and the
// retention select work even when the database can't be opened, and neither
// control's own loaded value can be reverted by a slower init step running
// after the user has already interacted with it (M3).

async function saveSettings() {
  await chrome.storage.local.set({
    audit: { enabled: enabledCheckbox.checked, retentionDays: Number(retentionSelect.value) },
  });
}

async function initSettings() {
  const { audit } = await chrome.storage.local.get("audit");
  const { enabled, retentionDays } = { ...DEFAULT_SETTINGS, ...audit };
  enabledCheckbox.checked = enabled;
  // A stored value the select doesn't offer would otherwise leave the select
  // on some other option, and the next save would silently write that instead
  // of the value actually shown (M7).
  retentionSelect.value = String(VALID_RETENTIONS.includes(retentionDays) ? retentionDays : DEFAULT_SETTINGS.retentionDays);
  enabledCheckbox.addEventListener("change", saveSettings);
  retentionSelect.addEventListener("change", saveSettings);
}

// --- Sessions table ---

async function renderSessions() {
  const sessions = await AuditStore.listSessions(); // already newest first
  const rows = await Promise.all(sessions.map(async (session) => {
    const { actions, eventsByTab } = await AuditStore.getSession(session.id);
    return { session, actionCount: actions.length, tabCount: Object.keys(eventsByTab).length };
  }));

  sessionsBody.textContent = "";
  sessionsEmpty.hidden = rows.length > 0;
  for (const { session, actionCount, tabCount } of rows) {
    const tr = document.createElement("tr");
    tr.append(
      labelCell(session), td(session.cwd), td(String(session.pid)),
      td(formatTime(session.firstSeen)), td(formatTime(session.lastSeen)),
      td(String(actionCount)), td(String(tabCount)),
    );
    sessionsBody.appendChild(tr);
  }
}

// --- Session detail ---

async function showSessionDetail(id) {
  clearNotice();
  // Bind Delete and Export to this id before anything below can throw or
  // return early, so a failure never leaves them pointed at a previously
  // opened session (I2).
  deleteButton.onclick = () => deleteCurrentSession(id);
  exportLink.onclick = () => exportSession(id);

  const data = await AuditStore.getSession(id);
  if (!data.session) {
    // Gone since the row was rendered — for example the hourly audit-prune
    // alarm ran while this page was open. Don't show a broken detail view.
    currentSession = null;
    detailSection.hidden = true;
    showNotice("This session no longer exists.");
    await renderSessions();
    return;
  }

  currentSession = data;
  detailSection.hidden = false;
  renderActions();
  renderTabSelect();
}

function renderActions() {
  actionsBody.textContent = "";
  for (const action of currentSession.actions) {
    const tr = document.createElement("tr");
    tr.append(td(formatTime(action.ts)), td(action.tool), td(action.summary), td(action.outcome), td(`${action.ms} ms`));
    tr.addEventListener("click", () => seekToAction(action));
    actionsBody.appendChild(tr);
  }
}

function renderTabSelect() {
  tabSelect.textContent = "";
  const tabIds = Object.keys(currentSession.eventsByTab);
  for (const tabId of tabIds) {
    const opt = document.createElement("option");
    opt.value = tabId;
    opt.textContent = `Tab ${tabId}`;
    tabSelect.appendChild(opt);
  }
  tabSelect.onchange = () => renderPlayer(tabSelect.value);
  renderPlayer(tabIds[0]);
}

function destroyPlayer() {
  if (currentPlayer) {
    currentPlayer.$destroy();
    currentPlayer = null;
  }
  playerContainer.textContent = "";
}

function renderPlayer(tabId) {
  destroyPlayer();
  clearPlayerNotice();

  const events = tabId != null ? currentSession.eventsByTab[tabId] : undefined;
  // rrweb-player also refuses fewer than 2 events (a lone Meta or FullSnapshot
  // can't be replayed), so skip constructing it below that.
  if (!events || events.length < 2) return;

  try {
    // The vendored UMD bundle exposes window.rrwebPlayer as { Player, default
    // }, both the same class — not the class itself (see vendor/README.md).
    // Pass the container's own width so the player fits the page column
    // instead of overflowing it with its own default width (M9).
    currentPlayer = new rrwebPlayer.default({
      target: playerContainer,
      props: { events, autoPlay: false, width: playerContainer.clientWidth || undefined },
    });
  } catch (err) {
    // Malformed stored events (for example a corrupted recording) must not
    // break the rest of the detail view — the actions list stays usable (I2).
    // A failed construction can still have mounted a partial .rr-player (the
    // player builds its DOM scaffold before it processes the events array),
    // so clear it instead of leaving that behind.
    playerContainer.textContent = "";
    currentPlayer = null;
    showPlayerNotice("Replay unavailable for this tab.");
  }
}

// Clicking an action seeks the replay to its offset from the tab's first event,
// switching the tab selector first if the action belongs to a different tab.
function seekToAction(action) {
  if (action.tabId == null) return;
  const tabEvents = currentSession.eventsByTab[action.tabId];
  if (!tabEvents || tabEvents.length === 0) return;
  if (tabSelect.value !== String(action.tabId)) {
    tabSelect.value = String(action.tabId);
    renderPlayer(action.tabId);
  }
  if (currentPlayer) currentPlayer.goto(action.ts - tabEvents[0].timestamp);
}

// Built on click, not eagerly on every detail open, and revoked shortly after
// (M5) — a deleted session's exported JSON should not stay readable at an old
// URL, and a detail view that's never exported shouldn't hold a live blob.
function exportSession(id) {
  if (!currentSession || !currentSession.session || currentSession.session.id !== id) return;
  if (exportUrl) URL.revokeObjectURL(exportUrl);
  const blob = new Blob([JSON.stringify(currentSession)], { type: "application/json" });
  exportUrl = URL.createObjectURL(blob);
  exportLink.href = exportUrl;
  exportLink.download = `audit-session-${id}.json`;
  setTimeout(() => URL.revokeObjectURL(exportUrl), 0);
}

async function deleteCurrentSession(id) {
  await AuditStore.deleteSession(id);
  if (currentSession && currentSession.session && currentSession.session.id === id) {
    destroyPlayer();
    clearPlayerNotice();
    detailSection.hidden = true;
    currentSession = null;
    if (exportUrl) { URL.revokeObjectURL(exportUrl); exportUrl = null; }
  }
  await renderSessions();
}

// --- Init ---

async function auditDbExists() {
  if (typeof indexedDB.databases !== "function") return true; // no enumeration API: fall back to opening
  const dbs = await indexedDB.databases();
  return dbs.some((d) => d.name === "ocic-audit"); // must match store.js's AUDIT_DB_NAME
}

async function init() {
  await initSettings(); // wire the switch and select before anything that can block or fail (M3)
  if (await auditDbExists()) {
    await AuditStore.open();
    await renderSessions();
  } else {
    // Never create the database just by visiting the page (M4) — a plain
    // visit with audit never enabled has nothing recorded to show anyway.
    sessionsEmpty.hidden = false;
  }
}

init();

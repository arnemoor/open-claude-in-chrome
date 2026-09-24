// Options page: the audit mode switch and the session/replay viewer. Classic
// script (MV3 extension pages forbid inline script and eval). Reads and writes
// chrome.storage.local's "audit" key in the same shape Task 15's Audit.settings()
// reads ({ enabled, retentionDays }), and talks to the audit log only through
// AuditStore (extension/audit/store.js, loaded before this file).

const DEFAULT_SETTINGS = { enabled: false, retentionDays: 7 };

const enabledCheckbox = document.getElementById("audit-enabled");
const retentionSelect = document.getElementById("audit-retention");
const sessionsBody = document.getElementById("sessions-body");
const sessionsEmpty = document.getElementById("sessions-empty");
const detailSection = document.getElementById("session-detail");
const actionsBody = document.getElementById("actions-body");
const tabSelect = document.getElementById("tab-select");
const playerContainer = document.getElementById("player-container");
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

function formatTime(ts) {
  return new Date(ts).toLocaleString();
}

// --- Audit settings ---

async function saveSettings() {
  await chrome.storage.local.set({
    audit: { enabled: enabledCheckbox.checked, retentionDays: Number(retentionSelect.value) },
  });
}

async function initSettings() {
  const { audit } = await chrome.storage.local.get("audit");
  const { enabled, retentionDays } = { ...DEFAULT_SETTINGS, ...audit };
  enabledCheckbox.checked = enabled;
  retentionSelect.value = String(retentionDays);
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
      td(session.label), td(session.cwd), td(String(session.pid)),
      td(formatTime(session.firstSeen)), td(formatTime(session.lastSeen)),
      td(String(actionCount)), td(String(tabCount)),
    );
    tr.addEventListener("click", () => showSessionDetail(session.id));
    sessionsBody.appendChild(tr);
  }
}

// --- Session detail ---

async function showSessionDetail(id) {
  currentSession = await AuditStore.getSession(id);
  detailSection.hidden = false;

  renderActions();
  renderTabSelect();
  renderExportLink();
  deleteButton.onclick = () => deleteCurrentSession(id);
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

function renderPlayer(tabId) {
  if (currentPlayer) {
    currentPlayer.$destroy();
    currentPlayer = null;
  }
  const events = tabId != null ? currentSession.eventsByTab[tabId] : undefined;
  // rrweb-player also refuses fewer than 2 events (a lone Meta or FullSnapshot
  // can't be replayed), so skip constructing it below that.
  if (!events || events.length < 2) return;
  // The vendored UMD bundle exposes window.rrwebPlayer as { Player, default },
  // both the same class — not the class itself (see extension/vendor/README.md).
  currentPlayer = new rrwebPlayer.default({ target: playerContainer, props: { events, autoPlay: false } });
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

function renderExportLink() {
  if (exportUrl) URL.revokeObjectURL(exportUrl);
  const blob = new Blob([JSON.stringify(currentSession)], { type: "application/json" });
  exportUrl = URL.createObjectURL(blob);
  exportLink.href = exportUrl;
  exportLink.download = `audit-session-${currentSession.session.id}.json`;
}

async function deleteCurrentSession(id) {
  await AuditStore.deleteSession(id);
  if (currentPlayer) { currentPlayer.$destroy(); currentPlayer = null; }
  detailSection.hidden = true;
  currentSession = null;
  await renderSessions();
}

// --- Init ---

async function init() {
  await AuditStore.open();
  await initSettings();
  await renderSessions();
}

init();

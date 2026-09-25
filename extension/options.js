// Options page: the audit mode switch and the session/replay viewer. Classic
// script (MV3 extension pages forbid inline script and eval). Reads and writes
// chrome.storage.local's "audit" key in the same shape Audit.settings()
// (extension/audit/audit.js) reads ({ enabled, retentionDays }), and talks to
// the audit log only through AuditStore (extension/audit/store.js, loaded
// before this file).

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
const exportButton = document.getElementById("export-session");

let currentSession = null; // { session, actions, eventsByTab } for the open detail panel
let currentPlayer = null;

function td(text) {
  const cell = document.createElement("td");
  cell.textContent = text;
  return cell;
}

// The label cell holds a real <button>, not just a click handler on the <tr>,
// so keyboard users can reach and open a session too.
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
// The listeners are attached before the storage read even starts (not just
// before AuditStore is opened), and each control's loaded value is applied
// only if the user hasn't already changed that same control — so a click
// during the read is saved and is never reverted once the read resolves.

// The stored settings as the controls show them. A stored retention the select
// doesn't offer falls back to the default, so a save writes what is shown,
// not a value no control holds.
function shownSettings(audit) {
  const { enabled, retentionDays } = { ...DEFAULT_SETTINGS, ...audit };
  return { enabled: !!enabled, retentionDays: VALID_RETENTIONS.includes(retentionDays) ? retentionDays : DEFAULT_SETTINGS.retentionDays };
}

// Saves one changed field over the value read from storage, never over the
// other control, which shows its markup default until the first read
// resolves. Saves run one at a time, so two quick changes cannot both read the
// old value and let the second undo the first.
let settingsSaved = Promise.resolve();
function saveSetting(field, value) {
  settingsSaved = settingsSaved.catch(() => {}).then(async () => {
    const { audit } = await chrome.storage.local.get("audit");
    await chrome.storage.local.set({ audit: { ...shownSettings(audit), [field]: value } });
  });
  return settingsSaved;
}

async function initSettings() {
  let userChangedEnabled = false;
  let userChangedRetention = false;
  enabledCheckbox.addEventListener("change", () => { userChangedEnabled = true; saveSetting("enabled", enabledCheckbox.checked); });
  retentionSelect.addEventListener("change", () => { userChangedRetention = true; saveSetting("retentionDays", Number(retentionSelect.value)); });

  const { audit } = await chrome.storage.local.get("audit");
  const { enabled, retentionDays } = shownSettings(audit);
  if (!userChangedEnabled) enabledCheckbox.checked = enabled;
  if (!userChangedRetention) retentionSelect.value = String(retentionDays);
}

// --- Sessions table ---

async function renderSessions() {
  // A per-row getSession() would load every session's full recording (tens of
  // MB of rrweb events each) just to count actions and tabs —
  // listSessionSummaries gets both without ever touching an event row's own
  // events payload.
  const rows = await AuditStore.listSessionSummaries(); // already newest first

  sessionsBody.textContent = "";
  sessionsEmpty.hidden = rows.length > 0;
  for (const { session, actionCount, tabCount } of rows) {
    const tr = document.createElement("tr");
    tr.append(
      labelCell(session), td(session.cwd), td(String(session.pid)),
      td(formatTime(session.firstSeen)), td(formatTime(session.lastSeen)),
      td(String(actionCount)), td(String(tabCount)),
    );
    // The row looks clickable (options.css), so make the rest of it act that
    // way too — except where the click already landed on the label's own
    // button, which handles it itself.
    tr.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      showSessionDetail(session.id);
    });
    sessionsBody.appendChild(tr);
  }
}

// --- Session detail ---

async function showSessionDetail(id) {
  clearNotice();
  // Hide any previously-shown detail immediately, and unbind Delete/Export,
  // so neither can act on a stale session while this one loads — whether the
  // load succeeds, finds nothing, or rejects.
  detailSection.hidden = true;
  currentSession = null;
  deleteButton.onclick = null;
  exportButton.onclick = null;

  let data;
  try {
    data = await AuditStore.getSession(id);
  } catch (err) {
    showNotice("Could not load this session.");
    await renderSessions();
    return;
  }

  if (!data.session) {
    // Gone since the row was rendered — for example the hourly audit-prune
    // alarm ran while this page was open. Don't show a broken detail view.
    showNotice("This session no longer exists.");
    await renderSessions();
    return;
  }

  currentSession = data;
  deleteButton.onclick = () => deleteCurrentSession(id);
  exportButton.onclick = () => exportSession(id);
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

// preconnect, dns-prefetch, prefetch, preload and prerender links still open a
// real network connection to their recorded href when the player rebuilds them
// into the replay DOM — unlike a stylesheet, image or background fetch, the
// page CSP does not govern them. A neutralized link gets NEUTRAL_LINK_REL,
// which counts as blocked too, so building the player again for the same
// events (a tab switched back to) still treats it as neutralized.
const NEUTRAL_LINK_REL = "ocic-blocked";
const BLOCKED_LINK_RELS = new Set(["preconnect", "dns-prefetch", "prefetch", "preload", "prerender", NEUTRAL_LINK_REL]);

function hasBlockedRel(rel) {
  return typeof rel === "string" && rel.toLowerCase().split(/\s+/).some((token) => BLOCKED_LINK_RELS.has(token));
}

// Walks a snapshot (or added) node tree: records every <link> element's id in
// `links` (true once neutralized), and neutralizes the blocked ones in place.
// A blocked link keeps its node but loses what it could fetch: its href and
// imagesrcset go, and its rel becomes one no browser acts on. The node has to
// stay, because later mutations target its id: a page that loads its CSS the
// loadCSS way (<link rel="preload" as="style" onload="this.rel='stylesheet'">)
// gets its stylesheet text as a _cssText mutation on that node, which the
// player turns into a <style>.
function neutralizeLinksInTree(node, links) {
  if (!node || typeof node !== "object") return;
  if (node.type === 2 && typeof node.tagName === "string" && node.tagName.toLowerCase() === "link" && node.attributes) {
    const blocked = hasBlockedRel(node.attributes.rel);
    if (blocked) {
      delete node.attributes.href;
      delete node.attributes.imagesrcset;
      node.attributes.rel = NEUTRAL_LINK_REL;
    }
    links.set(node.id, blocked);
  }
  if (Array.isArray(node.childNodes)) for (const child of node.childNodes) neutralizeLinksInTree(child, links);
}

// Neutralizes blocked links in every FullSnapshot, mutation add and attribute
// mutation of an events array, in place — covers a recording stored before
// this fix too. An attribute mutation reaches the replay as well: on a
// neutralized link it may not bring back an href, an imagesrcset or a rel, and
// a blocked rel set on any other link neutralizes that link from then on. The
// player applies events in timestamp order, whatever order they were stored
// in, so they are walked in that order.
function neutralizeBlockedLinks(events) {
  const ordered = (events || []).filter((e) => e && typeof e === "object" && e.data).sort((a, b) => a.timestamp - b.timestamp);
  let links = new Map(); // rrweb id of each <link> element -> true once neutralized
  for (const event of ordered) {
    if (event.type === 2) {
      links = new Map(); // a FullSnapshot describes the whole document afresh
      neutralizeLinksInTree(event.data.node, links);
    } else if (event.type === 3 && event.data.source === 0) {
      for (const add of event.data.adds || []) if (add) neutralizeLinksInTree(add.node, links);
      for (const mutation of event.data.attributes || []) {
        const attributes = mutation && mutation.attributes;
        if (!attributes || !links.has(mutation.id)) continue;
        if (links.get(mutation.id)) {
          delete attributes.href;
          delete attributes.imagesrcset;
          if ("rel" in attributes) attributes.rel = NEUTRAL_LINK_REL;
        } else if (hasBlockedRel(attributes.rel)) {
          attributes.rel = NEUTRAL_LINK_REL;
          attributes.href = null; // null removes the attribute the node already has
          attributes.imagesrcset = null;
          links.set(mutation.id, true);
        }
      }
    }
  }
  return events;
}

function renderPlayer(tabId) {
  destroyPlayer();
  clearPlayerNotice();

  const events = tabId != null ? currentSession.eventsByTab[tabId] : undefined;
  if (!events || events.length === 0) return;

  // Age-based pruning (or a batch dropped before it was ever stored) can leave
  // a tab's stream with no FullSnapshot of its own to replay from — covers a
  // recording stored before store.js's own prune fix closed this for new ones,
  // too.
  if (!events.some((e) => e && e.type === 2)) {
    showPlayerNotice("Replay unavailable: the start of this recording was deleted by retention.");
    return;
  }

  neutralizeBlockedLinks(events);

  // rrweb-player also refuses fewer than 2 events (a lone Meta or FullSnapshot
  // can't be replayed), so skip constructing it below that.
  if (events.length < 2) return;

  try {
    // The vendored UMD bundle exposes window.rrwebPlayer as { Player, default
    // }, both the same class — not the class itself (see vendor/README.md).
    // Pass the container's own width so the player fits the page column
    // instead of overflowing it with its own default width.
    currentPlayer = new rrwebPlayer.default({
      target: playerContainer,
      props: { events, autoPlay: false, width: playerContainer.clientWidth || undefined },
    });
  } catch (err) {
    // Malformed stored events (for example a corrupted recording) must not
    // break the rest of the detail view — the actions list stays usable.
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
  // Retried batches can arrive (and be stored) out of order, so the first
  // element isn't reliably the earliest event — seek from the true minimum
  // timestamp instead of assuming array order. A loop, not
  // Math.min(...tabEvents...), since a large recording's events array can
  // exceed the engine's argument-spread limit.
  let firstEventTs = tabEvents[0].timestamp;
  for (const e of tabEvents) if (e.timestamp < firstEventTs) firstEventTs = e.timestamp;
  if (currentPlayer) currentPlayer.goto(action.ts - firstEventTs);
}

// Builds a detached <a download>, clicks it, and revokes its Blob URL shortly
// after — options.html keeps a plain, always-focusable <button> instead of a
// live export link. Each call uses its own local url/anchor, so concurrent
// clicks can't race each other's revoke.
async function exportSession(id) {
  try {
    // A fresh copy at click time — currentSession is the copy loaded when the
    // detail was opened, and the session can keep recording (and adding to
    // that copy in storage) while its detail stays open.
    const data = await AuditStore.getSession(id);
    if (!data.session || data.session.id !== id) return;
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-session-${id}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch (err) {
    // A failed load (or a recording too large to serialize) must not throw
    // uncaught or silently do nothing.
    showNotice("Could not export this session.");
  }
}

async function deleteCurrentSession(id) {
  try {
    await AuditStore.deleteSession(id);
  } catch (err) {
    // A failed delete must not throw uncaught or silently do nothing.
    showNotice("Could not delete this session.");
    return;
  }
  if (currentSession && currentSession.session && currentSession.session.id === id) {
    destroyPlayer();
    clearPlayerNotice();
    detailSection.hidden = true;
    currentSession = null;
    deleteButton.onclick = null;
    exportButton.onclick = null;
  }
  await renderSessions();
}

// --- Init ---

async function auditDbExists() {
  if (typeof indexedDB.databases !== "function") return true; // no enumeration API: fall back to opening
  try {
    const dbs = await indexedDB.databases();
    return dbs.some((d) => d.name === "ocic-audit"); // must match store.js's AUDIT_DB_NAME
  } catch (err) {
    return true; // enumeration failed: fall back to opening, same as the missing-API branch
  }
}

async function init() {
  await initSettings(); // wire the switch and select before anything that can block or fail
  if (await auditDbExists()) {
    try {
      await AuditStore.open();
      await renderSessions();
    } catch (err) {
      showNotice("Could not open the audit database.");
      sessionsEmpty.hidden = false;
    }
  } else {
    // Never create the database just by visiting the page — a plain visit
    // with audit never enabled has nothing recorded to show anyway.
    sessionsEmpty.hidden = false;
  }
}

init();

// Persists the audit log in the browser profile's IndexedDB ("ocic-audit"). Never
// touched unless audit mode is enabled (see audit.js) — nothing here runs, and no
// database is created, until the extension's own options page turns it on.
// Classic script, loaded via importScripts; defines globalThis.AuditStore.

const AUDIT_DB_NAME = "ocic-audit";
const AUDIT_DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(AUDIT_DB_NAME, AUDIT_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "id" });
      if (!db.objectStoreNames.contains("actions")) db.createObjectStore("actions", { autoIncrement: true }).createIndex("sessionId", "sessionId");
      if (!db.objectStoreNames.contains("events")) db.createObjectStore("events", { autoIncrement: true }).createIndex("sessionId", "sessionId");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getDb() {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

async function open() {
  await getDb();
}

function reqp(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("audit store transaction aborted"));
  });
}

async function upsertSession(session, ts) {
  const db = await getDb();
  const tx = db.transaction("sessions", "readwrite");
  const sessionsStore = tx.objectStore("sessions");
  const existing = await reqp(sessionsStore.get(session.id));
  sessionsStore.put({
    id: session.id,
    label: session.label,
    cwd: session.cwd,
    pid: session.pid,
    firstSeen: existing ? existing.firstSeen : ts,
    lastSeen: ts,
  });
  await txDone(tx);
}

async function addAction(action) {
  const db = await getDb();
  const tx = db.transaction("actions", "readwrite");
  tx.objectStore("actions").add(action);
  await txDone(tx);
}

async function addEvents(sessionId, tabId, events) {
  const db = await getDb();
  const tx = db.transaction("events", "readwrite");
  tx.objectStore("events").add({ sessionId, tabId, ts: Date.now(), events });
  await txDone(tx);
}

async function listSessions() {
  const db = await getDb();
  const tx = db.transaction("sessions", "readonly");
  const all = await reqp(tx.objectStore("sessions").getAll());
  await txDone(tx);
  return all.sort((a, b) => b.lastSeen - a.lastSeen);
}

async function getSession(id) {
  const db = await getDb();
  const tx = db.transaction(["sessions", "actions", "events"], "readonly");
  const session = await reqp(tx.objectStore("sessions").get(id));
  const actions = await reqp(tx.objectStore("actions").index("sessionId").getAll(id));
  const eventRows = await reqp(tx.objectStore("events").index("sessionId").getAll(id));
  await txDone(tx);

  const eventsByTab = {};
  for (const row of eventRows) {
    if (!eventsByTab[row.tabId]) eventsByTab[row.tabId] = [];
    eventsByTab[row.tabId].push(...row.events);
  }
  return { session, actions, eventsByTab };
}

function deleteByIndex(objectStore, sessionId) {
  return new Promise((resolve, reject) => {
    const req = objectStore.index("sessionId").openCursor(IDBKeyRange.only(sessionId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
      else resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

async function deleteSession(id) {
  const db = await getDb();
  const tx = db.transaction(["sessions", "actions", "events"], "readwrite");
  tx.objectStore("sessions").delete(id);
  await deleteByIndex(tx.objectStore("actions"), id);
  await deleteByIndex(tx.objectStore("events"), id);
  await txDone(tx);
}

async function prune({ retentionDays, maxSessions, now } = {}) {
  const ts = typeof now === "number" ? now : Date.now();
  const all = await listSessions(); // newest first
  const toDelete = new Set();

  if (typeof retentionDays === "number") {
    const cutoff = ts - retentionDays * 24 * 60 * 60 * 1000;
    for (const s of all) if (s.lastSeen < cutoff) toDelete.add(s.id);
  }
  if (typeof maxSessions === "number") {
    const survivors = all.filter((s) => !toDelete.has(s.id));
    for (const s of survivors.slice(maxSessions)) toDelete.add(s.id);
  }
  for (const id of toDelete) await deleteSession(id);
}

globalThis.AuditStore = { open, upsertSession, addAction, addEvents, listSessions, getSession, deleteSession, prune };

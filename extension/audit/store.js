// Persists the audit log in the browser profile's IndexedDB ("ocic-audit"). Never
// touched unless audit mode is enabled (see audit.js) — nothing here runs, and no
// database is created, until the extension's own options page turns it on.
// Classic script, loaded via importScripts; defines only globalThis.AuditStore
// (everything else here is wrapped in an IIFE so it can't collide with anything
// in the shared worker scope, or — on options.html — with window.open).

(() => {
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
      req.onsuccess = () => {
        const db = req.result;
        // A single failed open (a disk error, "Internal error opening backing
        // store") or a connection the browser closes out from under us must not
        // disable audit until the worker restarts — drop the cache so the next
        // getDb() call reopens fresh instead of reusing a dead connection.
        db.onclose = () => { dbPromise = null; };
        // Another connection (a later schema bump, options.html reloading with
        // a newer AUDIT_DB_VERSION) wants to upgrade: get out of its way rather
        // than blocking it forever.
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => { dbPromise = null; reject(req.error); };
      req.onblocked = () => { dbPromise = null; reject(new Error("audit store open blocked by another connection")); };
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

  async function hasSession(id) {
    const db = await getDb();
    const tx = db.transaction("sessions", "readonly");
    const session = await reqp(tx.objectStore("sessions").get(id));
    await txDone(tx);
    return !!session;
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

  // Deletes rows with ts < cutoff, oldest first. autoIncrement keys are handed
  // out in insertion order, and insertion order here is chronological (actions
  // and events are always added with the current or a past ts) — so a cursor
  // walking the store in its default (ascending primary-key) order can stop the
  // moment it sees a row that isn't old enough, without a schema change.
  function deleteOlderThan(objectStore, cutoff) {
    return new Promise((resolve, reject) => {
      const req = objectStore.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(); return; }
        if (cursor.value.ts < cutoff) { cursor.delete(); cursor.continue(); }
        else resolve();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function prune({ retentionDays, maxSessions, now } = {}) {
    const ts = typeof now === "number" ? now : Date.now();
    const all = await listSessions(); // newest first
    const toDelete = new Set();
    const cutoff = typeof retentionDays === "number" ? ts - retentionDays * 24 * 60 * 60 * 1000 : null;

    if (cutoff !== null) {
      for (const s of all) if (s.lastSeen < cutoff) toDelete.add(s.id);
    }
    if (typeof maxSessions === "number") {
      const survivors = all.filter((s) => !toDelete.has(s.id));
      for (const s of survivors.slice(maxSessions)) toDelete.add(s.id);
    }
    for (const id of toDelete) await deleteSession(id);

    // I4: a session that is still active (recent lastSeen, so it survives above)
    // can still be holding actions/events from well outside the retention
    // window — age those out independently of which session owns them.
    if (cutoff !== null) {
      const db = await getDb();
      const tx = db.transaction(["actions", "events"], "readwrite");
      await deleteOlderThan(tx.objectStore("actions"), cutoff);
      await deleteOlderThan(tx.objectStore("events"), cutoff);
      await txDone(tx);
    }
  }

  globalThis.AuditStore = { open, upsertSession, hasSession, addAction, addEvents, listSessions, getSession, deleteSession, prune };
})();

// A tiny JSON-lines file logger for the native host and each MCP server. The
// browser starts the native host and discards its stderr, and Claude only
// surfaces an MCP server's stderr while it is attached, so this file is the
// only durable record of why a host process started, changed role or exited.
// It must never throw: a logging failure must never take down the process it
// is trying to explain, and it must never log tool arguments or results.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOCK_STALE_MS = 10_000;

export function createLogger(name, { home = os.homedir(), maxBytes = 1_000_000 } = {}) {
  const dir = path.join(home, ".config", "open-claude-in-chrome", "logs");
  const file = path.join(dir, `${name}.log`);
  const lockFile = `${file}.lock`;

  // Rotation is best-effort and serialized across processes with an exclusive
  // lock file, so two writers racing on the same over-limit file don't both
  // rename at once (the second rename would silently replace the first
  // writer's freshly rotated .1, dropping whatever it had just preserved).
  function rotateIfNeeded() {
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return; // no existing file to rotate
    }
    if (size <= maxBytes) return;

    let lockFd;
    try {
      lockFd = fs.openSync(lockFile, "wx", 0o600);
    } catch (e) {
      if (e.code === "EEXIST") {
        // Someone else is rotating right now, or died mid-rotation. Either
        // way this write skips rotation and just appends below — the file
        // may run a few lines over the limit, which is fine. If the lock
        // looks stale, clear it so the NEXT write can rotate.
        try {
          if (Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lockFile);
        } catch {
          // lock vanished or stat failed between the two calls; nothing to do
        }
      }
      return;
    }
    try {
      fs.closeSync(lockFd);
      // Re-check inside the lock: another writer may already have rotated
      // while this one was racing to create the lock file.
      if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`);
    } finally {
      try { fs.unlinkSync(lockFile); } catch { /* already gone */ }
    }
  }

  function write(level, event, data) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      // The append below will fail too, for the same reason, and is
      // swallowed there.
    }
    try {
      rotateIfNeeded();
    } catch {
      // A rotation failure of any kind must never drop the line itself.
    }
    try {
      // Fixed fields are assembled first and never overwritten: a same-named
      // key in `data` (e.g. a hub forwarding a client's own pid) must not be
      // able to shadow the writing process's own pid, timestamp, name,
      // level or event. Object.hasOwn (not `in`) so a payload key that only
      // exists on Object.prototype (constructor, toString, ...) is treated
      // as an ordinary key, not mistaken for a collision. A null/undefined
      // payload (info(event, null)) is treated as {}, not a hard failure.
      const line = { ts: new Date().toISOString(), pid: process.pid, name, level, event };
      for (const [k, v] of Object.entries(data ?? {})) {
        if (!Object.hasOwn(line, k)) line[k] = v;
      }
      fs.appendFileSync(file, JSON.stringify(line) + "\n", { mode: 0o600 });
    } catch {
      // Logging must never crash the process it is trying to explain.
    }
  }

  return {
    info(event, data = {}) { write("info", event, data); },
    error(event, data = {}) { write("error", event, data); },
  };
}

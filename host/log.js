// A tiny JSON-lines file logger for the native host and each MCP server. The
// browser starts the native host and discards its stderr, and Claude only
// surfaces an MCP server's stderr while it is attached, so this file is the
// only durable record of why a host process started, changed role or exited.
// It must never throw: a logging failure must never take down the process it
// is trying to explain, and it must never log tool arguments or results.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createLogger(name, { home = os.homedir(), maxBytes = 1_000_000 } = {}) {
  const dir = path.join(home, ".config", "open-claude-in-chrome", "logs");
  const file = path.join(dir, `${name}.log`);

  function rotateIfNeeded() {
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return; // no existing file to rotate
    }
    if (size > maxBytes) fs.renameSync(file, `${file}.1`);
  }

  function write(level, event, data) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      rotateIfNeeded();
      const line = JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, name, level, event, ...data });
      fs.appendFileSync(file, line + "\n", { mode: 0o600 });
    } catch {
      // Logging must never crash the process it is trying to explain.
    }
  }

  return {
    info(event, data = {}) { write("info", event, data); },
    error(event, data = {}) { write("error", event, data); },
  };
}

// The bridge hub: owned by the native host, listens on a per-user Unix socket, and
// relays tool requests from any number of MCP-server clients to the browser
// extension. If another hub already serves the socket, this one waits in standby
// and takes over automatically when the first goes away.
//
// Placement: a fresh listen always binds a private, unique temp name inside the
// run directory, then places it at sockPath with fs.linkSync (EEXIST plays the
// role EADDRINUSE used to play). The temp name is unlinked immediately after a
// successful link, so the only path net.Server ever auto-unlinks on close() is
// that already-gone temp name — it never touches sockPath. stop() does its own
// inode-checked unlink of sockPath, so nothing can ever be removed or replaced
// out from under a hub that currently owns the path.

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { prepareBridgeDir, assertSocketPathFits, BridgeSecurityError, PROTOCOL_VERSION } from "./bridge-endpoint.js";

const TOO_LARGE = "Request is too large for the browser channel (limit 1 MB).";
const MAX_REQUEST_BYTES = 1_000_000;

export class BridgeHub {
  constructor({
    sockPath,
    sendToExtension,
    log = () => {},
    helloTimeoutMs = 2000,
    standbyRetryMs = 2000,
    maxLineBytes = 16 * 1024 * 1024,
    selfCheckMs = 5000,
  }) {
    this.sockPath = sockPath;
    this.sendToExtension = sendToExtension;
    this.log = log;
    this.helloTimeoutMs = helloTimeoutMs;
    this.standbyRetryMs = standbyRetryMs;
    this.maxLineBytes = maxLineBytes;
    this.selfCheckMs = selfCheckMs;

    this.runId = crypto.randomBytes(4).toString("hex");
    this._state = "idle";
    this._sessionCounter = 0;
    this._conns = new Set(); // every accepted connection, ready or not (I1)
    this._pending = new Map(); // hubId -> { conn, localId }
    this._ino = null;
    this._server = null; // the currently-live listening server, or null
    this._standbyTimer = null;
    this._selfCheckTimer = null;
  }

  get state() { return this._state; }
  get clientCount() {
    let n = 0;
    for (const c of this._conns) if (c.ready) n++;
    return n;
  }

  async start() {
    const result = await this._tryBecomeServer();
    return this._applyAcquireResult(result, "serving");
  }

  // --- becoming the server ------------------------------------------------

  // Repeats bind-temp / link / (on contention) probe-or-clear-stale until it
  // either becomes the server or determines a live hub already serves the
  // path. Resolves { outcome: "serving", server, ino } or { outcome: "standby" }.
  // Resolves { outcome: "aborted" } (having cleaned up anything it created) if
  // stop() runs while it is working. Rejects with BridgeSecurityError (a
  // non-socket occupies the path) or another fs/net error.
  async _tryBecomeServer() {
    for (;;) {
      if (this._state === "stopped") return { outcome: "aborted" };

      assertSocketPathFits(this.sockPath);
      prepareBridgeDir(path.dirname(this.sockPath));

      if (this._state === "stopped") return { outcome: "aborted" };

      // A dot-prefixed 10-char name (".t" + 8 hex) is one byte shorter than
      // "bridge.sock" itself, so any sockPath that already passed the check
      // above cannot have its temp placement name overflow the platform's
      // sun_path limit. Checked again anyway, in case that ever changes.
      const tmpPath = path.join(path.dirname(this.sockPath), `.t${crypto.randomBytes(4).toString("hex")}`);
      assertSocketPathFits(tmpPath);
      const tmpServer = net.createServer((sock) => this._onConnection(sock));
      tmpServer.on("error", () => {}); // safety net; the promise below owns real listen errors
      await new Promise((resolve, reject) => {
        const onErr = (err) => { tmpServer.removeListener("listening", onOk); reject(err); };
        const onOk = () => { tmpServer.removeListener("error", onErr); resolve(); };
        tmpServer.once("error", onErr);
        tmpServer.once("listening", onOk);
        tmpServer.listen(tmpPath);
      });
      fs.chmodSync(tmpPath, 0o600);

      if (this._state === "stopped") {
        await this._closeServer(tmpServer);
        try { fs.unlinkSync(tmpPath); } catch { /* already gone via close()'s own unlink */ }
        return { outcome: "aborted" };
      }

      let linkErr = null;
      try {
        fs.linkSync(tmpPath, this.sockPath);
      } catch (e) {
        linkErr = e;
      }

      if (!linkErr) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        const ino = fs.statSync(this.sockPath).ino;
        if (this._state === "stopped") {
          await this._closeServer(tmpServer);
          try {
            if (fs.statSync(this.sockPath).ino === ino) fs.unlinkSync(this.sockPath);
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
          return { outcome: "aborted" };
        }
        return { outcome: "serving", server: tmpServer, ino };
      }

      // Contended or a hard failure: either way we do not need this attempt's
      // temp server.
      await this._closeServer(tmpServer);
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }

      if (linkErr.code !== "EEXIST") throw linkErr;
      if (this._state === "stopped") return { outcome: "aborted" };

      const probeResult = await this._probe();
      if (this._state === "stopped") return { outcome: "aborted" };
      if (probeResult === "standby") return { outcome: "standby" };
      // "retry": the path was cleared (or was already clear). Loop and link again.
    }
  }

  // Tells a live hub (still serving the path) from a stale socket file. lstats
  // the path BEFORE probing; after a refused connect, re-lstats and unlinks
  // only if the inode is still the one seen before the probe — closing the
  // window where a second hub could already have claimed the path in between.
  // Resolves "standby" or "retry". Rejects with BridgeSecurityError for a
  // non-socket file, which is never deleted.
  _probe() {
    return new Promise((resolve, reject) => {
      let before;
      try {
        before = fs.lstatSync(this.sockPath);
      } catch (e) {
        if (e.code === "ENOENT") { resolve("retry"); return; }
        reject(e);
        return;
      }
      if (!before.isSocket()) {
        reject(new BridgeSecurityError(`Refusing to remove non-socket at bridge path ${this.sockPath}.`));
        return;
      }
      const sock = net.createConnection(this.sockPath);
      sock.once("connect", () => { sock.destroy(); resolve("standby"); });
      sock.once("error", (err) => {
        sock.destroy();
        if (err.code !== "ECONNREFUSED" && err.code !== "ENOENT" && err.code !== "ENOTSOCK") { reject(err); return; }
        let now;
        try {
          now = fs.lstatSync(this.sockPath);
        } catch (e) {
          if (e.code === "ENOENT") { resolve("retry"); return; }
          reject(e);
          return;
        }
        if (now.ino !== before.ino) { resolve("retry"); return; } // something else is there now
        try {
          fs.unlinkSync(this.sockPath);
        } catch (e) {
          if (e.code !== "ENOENT") { reject(e); return; }
        }
        resolve("retry");
      });
    });
  }

  // Applies a settled _tryBecomeServer() outcome: updates state/server/ino,
  // logs, and arms the follow-up timer (self-check or standby retry).
  _applyAcquireResult(result, servingEvent) {
    if (result.outcome === "aborted") return "stopped";
    if (result.outcome === "serving") {
      this._server = result.server;
      this._ino = result.ino;
      this._state = "serving";
      this.log(servingEvent, { sockPath: this.sockPath });
      this._scheduleSelfCheck();
      return "serving";
    }
    this._state = "standby";
    this.log("standby", { sockPath: this.sockPath });
    this._scheduleStandbyRetry();
    return "standby";
  }

  _scheduleStandbyRetry() {
    this._standbyTimer = setTimeout(() => {
      if (this._state !== "standby") return;
      this._tryBecomeServer().then(
        (result) => this._applyAcquireResult(result, "takeover"),
        () => {
          // A background retry has no caller to report a failure to. Stay in
          // standby and keep trying rather than take the host process down.
          if (this._state !== "stopped") {
            this._state = "standby";
            this._scheduleStandbyRetry();
          }
        },
      );
    }, this.standbyRetryMs);
    this._standbyTimer.unref();
  }

  // While serving, periodically confirms sockPath still points at our own
  // socket. A serving hub never otherwise notices its path being removed or
  // replaced out from under it (a killed sibling process, manual interference).
  _scheduleSelfCheck() {
    this._selfCheckTimer = setTimeout(() => this._runSelfCheck(), this.selfCheckMs);
    this._selfCheckTimer.unref();
  }

  async _runSelfCheck() {
    if (this._state !== "serving") return;
    let displaced;
    try {
      const st = fs.lstatSync(this.sockPath);
      displaced = st.ino !== this._ino;
    } catch {
      displaced = true;
    }
    if (!displaced) {
      this._scheduleSelfCheck();
      return;
    }
    this.log("displaced", { sockPath: this.sockPath });
    this._destroyAllConns();
    const oldServer = this._server;
    this._server = null;
    this._ino = null;
    if (oldServer) await this._closeServer(oldServer);
    if (this._state === "stopped") return;
    try {
      const result = await this._tryBecomeServer();
      this._applyAcquireResult(result, "takeover");
    } catch {
      if (this._state !== "stopped") {
        this._state = "standby";
        this._scheduleStandbyRetry();
      }
    }
  }

  _closeServer(server) {
    return new Promise((resolve) => {
      if (!server.listening) { resolve(); return; }
      server.close(() => resolve());
    });
  }

  _destroyAllConns() {
    for (const conn of this._conns) {
      clearTimeout(conn.helloTimer);
      conn.socket.destroy();
    }
    this._conns.clear();
    this._pending.clear();
  }

  // --- per-connection protocol ---------------------------------------------

  _onConnection(sock) {
    sock.on("error", () => {}); // must be attached before anything else touches the socket
    sock.setNoDelay?.(); // no-op on Unix sockets; harmless

    const conn = {
      socket: sock,
      ready: false,
      rejected: false,
      session: null,
      label: undefined,
      pid: undefined,
      cwd: undefined,
      buffer: Buffer.alloc(0),
      helloTimer: null,
      rejectTimer: null,
    };
    this._conns.add(conn);

    conn.helloTimer = setTimeout(() => {
      if (!conn.ready && !conn.rejected) {
        this.log("peer_rejected", { reason: "hello_timeout" });
        conn.rejected = true;
        sock.destroy();
      }
    }, this.helloTimeoutMs);
    conn.helloTimer.unref();

    sock.on("data", (chunk) => this._onData(conn, chunk));
    sock.on("close", () => this._onClose(conn));
  }

  _onData(conn, chunk) {
    conn.buffer = Buffer.concat([conn.buffer, chunk]);
    let idx;
    while ((idx = conn.buffer.indexOf(10)) !== -1) {
      const lineBuf = conn.buffer.subarray(0, idx);
      conn.buffer = conn.buffer.subarray(idx + 1);
      if (lineBuf.length > this.maxLineBytes) {
        if (!conn.ready && !conn.rejected) this.log("peer_rejected", { reason: "line_too_long" });
        conn.rejected = true;
        conn.socket.destroy();
        return;
      }
      this._onLine(conn, lineBuf);
      if (conn.socket.destroyed) return;
    }
    if (conn.buffer.length > this.maxLineBytes) {
      if (!conn.ready && !conn.rejected) this.log("peer_rejected", { reason: "line_too_long" });
      conn.rejected = true;
      conn.socket.destroy();
    }
  }

  _onLine(conn, lineBuf) {
    // Once rejected (bad hello) or once we are no longer serving, ignore
    // anything further from this peer: never re-evaluate a later line as a
    // fresh hello, and never welcome or forward while stop() is tearing us
    // down (I1, M3).
    if (conn.rejected || this._state !== "serving") return;

    let msg;
    try {
      msg = JSON.parse(lineBuf.toString("utf-8"));
    } catch {
      msg = null;
    }

    if (!conn.ready) {
      if (!msg || msg.type !== "hello" || msg.protocol !== PROTOCOL_VERSION) {
        conn.rejected = true;
        clearTimeout(conn.helloTimer);
        this._writeLine(conn.socket, { type: "error", error: "Expected hello." });
        this.log("peer_rejected", { reason: "bad_hello" });
        conn.socket.end();
        // end() alone only half-closes our side; a peer that keeps reading
        // (allowHalfOpen) would otherwise never be dropped except by stop().
        conn.rejectTimer = setTimeout(() => conn.socket.destroy(), 1000);
        conn.rejectTimer.unref();
        return;
      }
      clearTimeout(conn.helloTimer);
      conn.ready = true;
      conn.session = "s" + (++this._sessionCounter);
      conn.label = msg.label;
      conn.pid = msg.pid;
      conn.cwd = msg.cwd;
      this._writeLine(conn.socket, { type: "welcome", protocol: PROTOCOL_VERSION, session: conn.session });
      this.log("client_connected", { session: conn.session });
      return;
    }

    if (!msg || msg.type !== "tool_request") return; // ignore anything else post-hello
    this._onToolRequest(conn, msg);
  }

  _onToolRequest(conn, msg) {
    const { id, tool } = msg;
    if (!(typeof id === "string" || typeof id === "number") || typeof tool !== "string") {
      this._writeLine(conn.socket, { type: "tool_error", id: msg.id, error: "Malformed request." });
      return;
    }

    const hubId = `${this.runId}.${conn.session}.${String(id)}`;
    if (this._pending.has(hubId)) {
      this._writeLine(conn.socket, { type: "tool_error", id, error: "Duplicate request id." });
      return;
    }

    const extMsg = {
      type: "tool_request",
      id: hubId,
      tool,
      args: msg.args ?? {},
      session: { id: conn.session, label: conn.label, pid: conn.pid, cwd: conn.cwd },
    };
    if (Buffer.byteLength(JSON.stringify(extMsg)) > MAX_REQUEST_BYTES) {
      this._writeLine(conn.socket, { type: "tool_error", id, error: TOO_LARGE });
      return;
    }

    this._pending.set(hubId, { conn, localId: id });
    this.sendToExtension(extMsg);
  }

  handleExtensionMessage(msg) {
    if (!msg || typeof msg.id !== "string" || (msg.type !== "tool_response" && msg.type !== "tool_error")) {
      this.log("bad_extension_message", { type: msg && msg.type });
      return;
    }
    const pending = this._pending.get(msg.id);
    if (!pending) return; // unknown owner — drop silently
    this._pending.delete(msg.id);
    if (pending.conn.socket.destroyed) return; // owner disconnected — drop silently
    if (msg.type === "tool_response") {
      this._writeLine(pending.conn.socket, { type: "tool_response", id: pending.localId, result: msg.result });
    } else {
      this._writeLine(pending.conn.socket, { type: "tool_error", id: pending.localId, error: msg.error });
    }
  }

  _onClose(conn) {
    clearTimeout(conn.helloTimer);
    clearTimeout(conn.rejectTimer);
    this._conns.delete(conn);
    if (!conn.ready) return;
    for (const [hubId, pending] of this._pending) {
      if (pending.conn === conn) this._pending.delete(hubId);
    }
    this.log("client_disconnected", { session: conn.session });
  }

  _writeLine(socket, obj) {
    if (socket.destroyed) return;
    try {
      socket.write(JSON.stringify(obj) + "\n");
    } catch {
      // socket went away mid-write; nothing to do
    }
  }

  async stop(reason) {
    if (this._state === "stopped") return;
    const wasServing = this._state === "serving";
    const ino = this._ino;
    this._state = "stopped";

    if (this._standbyTimer) { clearTimeout(this._standbyTimer); this._standbyTimer = null; }
    if (this._selfCheckTimer) { clearTimeout(this._selfCheckTimer); this._selfCheckTimer = null; }

    // Destroy every accepted connection — ready or still mid-handshake (I1) —
    // before closing the server, so close() never waits on a silent peer.
    this._destroyAllConns();

    const server = this._server;
    this._server = null;
    if (server) await this._closeServer(server);

    // close() above only ever unlinks its own (already-gone) private temp
    // name, never sockPath itself (see the module comment), so this is the
    // only place sockPath is ever removed, and only when it is still ours.
    if (wasServing && ino !== null) {
      try {
        const st = fs.statSync(this.sockPath);
        if (st.ino === ino) fs.unlinkSync(this.sockPath);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    void reason; // informational only; the caller does its own exit logging
  }
}

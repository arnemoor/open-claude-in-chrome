// The bridge hub: owned by the native host, listens on a per-user Unix socket, and
// relays tool requests from any number of MCP-server clients to the browser
// extension. If another hub already serves the socket, this one waits in standby
// and takes over automatically when the first goes away.

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
  }) {
    this.sockPath = sockPath;
    this.sendToExtension = sendToExtension;
    this.log = log;
    this.helloTimeoutMs = helloTimeoutMs;
    this.standbyRetryMs = standbyRetryMs;
    this.maxLineBytes = maxLineBytes;

    this.runId = crypto.randomBytes(4).toString("hex");
    this._state = "idle";
    this._sessionCounter = 0;
    this._clients = new Set(); // Set<conn>
    this._pending = new Map(); // hubId -> { conn, localId }
    this._ino = null;
    this._standbyTimer = null;

    this.server = net.createServer((sock) => this._onConnection(sock));
    // A safety net only: the per-attempt listeners in _attemptListen cover the
    // real listen()/probe errors. This just stops a stray 'error' with no
    // listener from throwing and taking the whole host process down.
    this.server.on("error", () => {});
  }

  get state() { return this._state; }
  get clientCount() { return this._clients.size; }

  async start() {
    await this._tryListen(false);
    return this._state;
  }

  async _tryListen(fromStandby) {
    for (;;) {
      assertSocketPathFits(this.sockPath);
      prepareBridgeDir(path.dirname(this.sockPath));
      const outcome = await this._attemptListen();
      if (outcome === "listening") {
        this._afterListen();
        this._state = "serving";
        this.log(fromStandby ? "takeover" : "serving", { sockPath: this.sockPath });
        return;
      }
      if (outcome === "standby") {
        this._state = "standby";
        this.log("standby", { sockPath: this.sockPath });
        this._scheduleStandbyRetry();
        return;
      }
      // outcome === "retry": a stale socket was just unlinked. Loop and listen again.
    }
  }

  _attemptListen() {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server.removeListener("listening", onListening);
        if (err.code !== "EADDRINUSE") { reject(err); return; }
        this._probe().then(resolve, reject);
      };
      const onListening = () => {
        this.server.removeListener("error", onError);
        resolve("listening");
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.sockPath);
    });
  }

  // Tells a live hub (still serving the path) from a stale socket file left
  // behind by a hub that died without cleaning up.
  _probe() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.sockPath);
      sock.once("connect", () => { sock.destroy(); resolve("standby"); });
      sock.once("error", (err) => {
        sock.destroy();
        // ECONNREFUSED/ENOENT: a dead hub's leftover socket. ENOTSOCK: connect()
        // was pointed at a non-socket file — inconclusive by itself, so fall
        // through to the lstat-based classification below either way.
        if (err.code !== "ECONNREFUSED" && err.code !== "ENOENT" && err.code !== "ENOTSOCK") { reject(err); return; }
        let st;
        try {
          st = fs.lstatSync(this.sockPath);
        } catch (e) {
          if (e.code === "ENOENT") { resolve("retry"); return; } // already gone
          reject(e);
          return;
        }
        if (!st.isSocket()) {
          reject(new BridgeSecurityError(`Refusing to remove non-socket at bridge path ${this.sockPath}.`));
          return;
        }
        try {
          fs.unlinkSync(this.sockPath);
        } catch (e) {
          if (e.code !== "ENOENT") { reject(e); return; }
        }
        resolve("retry");
      });
    });
  }

  _scheduleStandbyRetry() {
    this._standbyTimer = setTimeout(() => {
      if (this._state !== "standby") return;
      this._tryListen(true).catch(() => {
        // A background retry has no caller to report a failure to. Stay in
        // standby and keep trying rather than take the host process down.
        if (this._state !== "stopped") {
          this._state = "standby";
          this._scheduleStandbyRetry();
        }
      });
    }, this.standbyRetryMs);
    this._standbyTimer.unref();
  }

  _afterListen() {
    fs.chmodSync(this.sockPath, 0o600);
    this._ino = fs.statSync(this.sockPath).ino;
  }

  _onConnection(sock) {
    sock.on("error", () => {}); // must be attached before anything else touches the socket
    sock.setNoDelay?.(); // no-op on Unix sockets; harmless

    const conn = {
      socket: sock,
      ready: false,
      session: null,
      label: undefined,
      pid: undefined,
      cwd: undefined,
      buffer: Buffer.alloc(0),
      helloTimer: null,
    };

    conn.helloTimer = setTimeout(() => {
      if (!conn.ready) {
        this.log("peer_rejected", { reason: "hello_timeout" });
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
        if (!conn.ready) this.log("peer_rejected", { reason: "line_too_long" });
        conn.socket.destroy();
        return;
      }
      this._onLine(conn, lineBuf);
      if (conn.socket.destroyed) return;
    }
    if (conn.buffer.length > this.maxLineBytes) {
      if (!conn.ready) this.log("peer_rejected", { reason: "line_too_long" });
      conn.socket.destroy();
    }
  }

  _onLine(conn, lineBuf) {
    let msg;
    try {
      msg = JSON.parse(lineBuf.toString("utf-8"));
    } catch {
      msg = null;
    }

    if (!conn.ready) {
      if (!msg || msg.type !== "hello" || msg.protocol !== PROTOCOL_VERSION) {
        this._writeLine(conn.socket, { type: "error", error: "Expected hello." });
        this.log("peer_rejected", { reason: "bad_hello" });
        conn.socket.end();
        return;
      }
      clearTimeout(conn.helloTimer);
      conn.ready = true;
      conn.session = "s" + (++this._sessionCounter);
      conn.label = msg.label;
      conn.pid = msg.pid;
      conn.cwd = msg.cwd;
      this._clients.add(conn);
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
    if (!conn.ready) return;
    this._clients.delete(conn);
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
    this._state = "stopped";
    if (this._standbyTimer) {
      clearTimeout(this._standbyTimer);
      this._standbyTimer = null;
    }
    for (const conn of this._clients) conn.socket.destroy();
    this._clients.clear();
    this._pending.clear();

    if (this.server.listening) {
      // net.Server unlinks whatever file currently sits at the bound path when
      // it closes, unconditionally — even if a later hub has since replaced
      // ours there. Move a foreign file aside for the duration of close() and
      // restore it after, so only a socket we still own (matching inode) is
      // ever actually removed.
      let rescuePath = null;
      if (wasServing && this._ino !== null) {
        try {
          const st = fs.statSync(this.sockPath);
          if (st.ino !== this._ino) {
            rescuePath = `${this.sockPath}.${process.pid}.rescue`;
            fs.renameSync(this.sockPath, rescuePath);
          }
        } catch (e) {
          if (e.code !== "ENOENT") throw e; // already gone: nothing to rescue
        }
      }
      await new Promise((resolve) => this.server.close(() => resolve()));
      if (rescuePath) fs.renameSync(rescuePath, this.sockPath);
    }
    void reason; // informational only; the caller does its own exit logging
  }
}

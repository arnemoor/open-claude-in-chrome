// A bridge client: connects an MCP server to the native host's Unix-socket hub.
// No session owns the link, so a session that exits never cuts off the others,
// and a session that starts before the browser (or survives a browser restart)
// just waits and reconnects on its own.

import net from "node:net";
import path from "node:path";
import { verifyBridgeDir, verifySocketOwner, BridgeSecurityError, PROTOCOL_VERSION } from "./bridge-endpoint.js";

export const NOT_CONNECTED = "Browser extension is not connected. Make sure a supported Chromium browser is running with the Open Claude in Chrome extension installed and enabled.";
export const LOST = "The browser connection was lost while this tool was running. It may or may not have completed. Check the page state (for example with a screenshot) before retrying.";
export const TOO_LARGE = "Request is too large for the browser channel (limit 1 MB).";

const WELCOME_TIMEOUT_MS = 2000;

export class BridgeClient {
  constructor({
    sockPath,
    hello,
    graceMs = 5000,
    requestTimeoutMs = 60000,
    retryMinMs = 250,
    retryMaxMs = 2000,
    log = () => {},
  }) {
    this.sockPath = sockPath;
    this.hello = hello;
    this.graceMs = graceMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.retryMinMs = retryMinMs;
    this.retryMaxMs = retryMaxMs;
    this.log = log;

    this._connected = false;
    this._closed = false;
    this._connecting = false;
    this._socket = null;
    this._pendingSocket = null;
    this._backoffMs = retryMinMs;
    this._retryTimer = null;
    this._pending = new Map(); // id -> { resolve, reject, timer, written }
    this._reqCounter = 0;
    this._connectWaiters = [];
    this._lastSecurityError = null;
    this._loggedSecurityError = null; // throttle: security_refusal logs once per distinct message
  }

  get connected() { return this._connected; }

  start() {
    if (this._closed) return;
    this._connectOnce();
  }

  request(tool, args) {
    return new Promise((resolve, reject) => {
      const id = String(++this._reqCounter);
      const entry = { resolve, reject, timer: null, written: false };
      const seconds = this.requestTimeoutMs / 1000;
      entry.timer = setTimeout(() => {
        if (this._pending.get(id) !== entry) return;
        this._pending.delete(id);
        reject(new Error(`Tool request timed out after ${seconds}s`));
      }, this.requestTimeoutMs);
      entry.timer.unref();
      this._pending.set(id, entry);

      const doWrite = () => {
        if (this._pending.get(id) !== entry) return; // already settled elsewhere
        entry.written = true;
        try {
          this._socket.write(JSON.stringify({ type: "tool_request", id, tool, args }) + "\n");
        } catch {
          // socket went away mid-write; the 'close' handler fails this with LOST
        }
      };

      if (this._connected) {
        doWrite();
        return;
      }

      this._connectNow();
      const waiter = () => {
        clearTimeout(graceTimer);
        doWrite();
      };
      const graceTimer = setTimeout(() => {
        if (this._pending.get(id) !== entry) return;
        this._pending.delete(id);
        clearTimeout(entry.timer);
        // Drop this request's own waiter instead of leaving it (and its args)
        // queued in _connectWaiters until the next welcome (M6).
        const idx = this._connectWaiters.indexOf(waiter);
        if (idx !== -1) this._connectWaiters.splice(idx, 1);
        let message = NOT_CONNECTED;
        if (this._lastSecurityError) message += ` Refusing to connect: ${this._lastSecurityError}`;
        reject(new Error(message));
      }, this.graceMs);
      graceTimer.unref();

      this._connectWaiters.push(waiter);
    });
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    if (this._pendingSocket) { this._pendingSocket.destroy(); this._pendingSocket = null; }
    if (this._socket) { this._socket.destroy(); this._socket = null; }
    this._connected = false;
    for (const [id, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Server shutting down"));
    }
    this._pending.clear();
    this._connectWaiters = [];
  }

  // --- connect loop -----------------------------------------------------

  async _connectOnce() {
    if (this._closed || this._connecting) return;
    this._connecting = true;
    try {
      const dir = path.dirname(this.sockPath);
      try {
        verifyBridgeDir(dir);
        verifySocketOwner(this.sockPath);
      } catch (err) {
        if (err instanceof BridgeSecurityError) {
          this._lastSecurityError = err.message;
          // Throttled: retrying every retryMinMs..retryMaxMs against a
          // directory that stays unsafe would otherwise log every retry.
          if (err.message !== this._loggedSecurityError) {
            this._loggedSecurityError = err.message;
            this.log("security_refusal", { message: err.message });
          }
        } else {
          this._lastSecurityError = null; // ENOENT: no hub running yet
        }
        this._scheduleRetry();
        return;
      }
      this._lastSecurityError = null;
      await this._connectSocket();
    } finally {
      this._connecting = false;
    }
  }

  _connectNow() {
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    this._connectOnce();
  }

  _scheduleRetry() {
    if (this._closed || this._retryTimer) return;
    const delay = this._backoffMs;
    this._backoffMs = Math.min(this._backoffMs * 2, this.retryMaxMs);
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._connectOnce();
    }, delay);
    this._retryTimer.unref();
  }

  _connectSocket() {
    return new Promise((resolve) => {
      if (this._closed) { resolve(); return; }
      const sock = net.createConnection(this.sockPath);
      this._pendingSocket = sock;
      sock.setNoDelay?.();
      sock.on("error", () => {}); // attached before anything else; 'close' does the real handling

      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };

      sock.once("connect", () => this._sendHello(sock));

      let buffer = Buffer.alloc(0);
      const welcomeTimer = setTimeout(() => sock.destroy(), WELCOME_TIMEOUT_MS);
      welcomeTimer.unref();

      sock.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        let idx;
        while ((idx = buffer.indexOf(10)) !== -1) {
          const lineBuf = buffer.subarray(0, idx);
          buffer = buffer.subarray(idx + 1);
          let msg;
          try { msg = JSON.parse(lineBuf.toString("utf-8")); } catch { continue; }
          if (!msg) continue;

          if (!this._connected && msg.type === "welcome") {
            clearTimeout(welcomeTimer);
            if (this._closed) { sock.destroy(); continue; }
            this._pendingSocket = null;
            this._socket = sock;
            this._connected = true;
            this._backoffMs = this.retryMinMs;
            this._loggedSecurityError = null; // a fresh connect clears the security_refusal throttle
            this.log("bridge_connected", { session: msg.session });
            this._releaseWaiters();
            finish();
          } else if (this._connected && sock === this._socket && (msg.type === "tool_response" || msg.type === "tool_error")) {
            this._handleReply(msg);
          }
        }
      });

      sock.once("close", () => {
        clearTimeout(welcomeTimer);
        if (this._pendingSocket === sock) this._pendingSocket = null;
        const wasConnected = this._connected && this._socket === sock;
        if (wasConnected) {
          this._connected = false;
          this._socket = null;
          this.log("bridge_lost", {});
          this._failWrittenPending(LOST);
        }
        finish();
        if (!this._closed) this._scheduleRetry();
      });
    });
  }

  _sendHello(sock) {
    const msg = { ...this.hello, type: "hello", protocol: PROTOCOL_VERSION };
    sock.write(JSON.stringify(msg) + "\n");
  }

  _releaseWaiters() {
    const waiters = this._connectWaiters;
    this._connectWaiters = [];
    for (const w of waiters) w();
  }

  _handleReply(msg) {
    const entry = this._pending.get(msg.id);
    if (!entry) return; // unknown or already settled
    this._pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.type === "tool_response") entry.resolve(msg.result);
    else entry.reject(new Error(msg.error));
  }

  _failWrittenPending(message) {
    for (const [id, entry] of this._pending) {
      if (entry.written) {
        this._pending.delete(id);
        clearTimeout(entry.timer);
        entry.reject(new Error(message));
      }
    }
  }
}

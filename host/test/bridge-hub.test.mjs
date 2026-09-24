import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { BridgeHub } from "../bridge-hub.js";
import { bridgePath, bridgeDir } from "../bridge-endpoint.js";
import { BridgeSecurityError } from "../bridge-endpoint.js";
import { tmpHome, startHub, waitFor, sleep, fakeExtension } from "./helpers.mjs";

function rawClient(sockPath) {
  const sock = net.createConnection(sockPath);
  const lines = [];
  let buf = "";
  sock.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
  });
  sock.on("error", () => {});
  const send = (o) => sock.write(JSON.stringify(o) + "\n");
  return { sock, lines, send };
}

async function helloClient(sockPath, label = "t") {
  const c = rawClient(sockPath);
  await new Promise((r) => c.sock.once("connect", r));
  c.send({ type: "hello", protocol: 2, pid: 1, ppid: 1, cwd: "/w/" + label, label });
  await waitFor(() => c.lines.some((l) => l.type === "welcome"));
  return c;
}

test("routes a request to the extension with a namespaced id and session, and the reply back", { timeout: 10000 }, async (t) => {
  const home = tmpHome();
  const { hub, ext } = await startHub(home);
  t.after(() => hub.stop("cleanup").catch(() => {}));
  const c = await helloClient(bridgePath(home), "app");
  t.after(() => c.sock.destroy());
  c.send({ type: "tool_request", id: "1", tool: "navigate", args: { url: "https://e.test", tabId: 3 } });
  await waitFor(() => ext.received.length === 1);
  const fwd = ext.received[0];
  assert.match(fwd.id, /^[0-9a-f]{8}\.s1\.1$/);
  assert.deepEqual(fwd.session, { id: "s1", label: "app", pid: 1, cwd: "/w/app" });
  assert.deepEqual(fwd.args, { url: "https://e.test", tabId: 3 });
  ext.reply(fwd, { content: [{ type: "text", text: "ok" }] });
  await waitFor(() => c.lines.some((l) => l.type === "tool_response"));
  assert.deepEqual(c.lines.find((l) => l.type === "tool_response"), { type: "tool_response", id: "1", result: { content: [{ type: "text", text: "ok" }] } });
  await hub.stop("test");
});

test("two clients using the same local id never see each other's replies", { timeout: 10000 }, async (t) => {
  const home = tmpHome();
  const { hub, ext } = await startHub(home);
  t.after(() => hub.stop("cleanup").catch(() => {}));
  const a = await helloClient(bridgePath(home), "a");
  t.after(() => a.sock.destroy());
  const b = await helloClient(bridgePath(home), "b");
  t.after(() => b.sock.destroy());
  a.send({ type: "tool_request", id: "1", tool: "find", args: {} });
  b.send({ type: "tool_request", id: "1", tool: "find", args: {} });
  await waitFor(() => ext.received.length === 2);
  for (const m of ext.received) ext.reply(m, m.session.label);
  await waitFor(() => a.lines.some((l) => l.type === "tool_response") && b.lines.some((l) => l.type === "tool_response"));
  assert.equal(a.lines.find((l) => l.type === "tool_response").result, "a");
  assert.equal(b.lines.find((l) => l.type === "tool_response").result, "b");
  await hub.stop("test");
});

test("abrupt, silent, garbage and oversized peers never take the hub down", { timeout: 10000 }, async (t) => {
  const home = tmpHome();
  const sock = bridgePath(home);
  const { hub, ext } = await startHub(home, { helloTimeoutMs: 200, maxLineBytes: 1024 });
  t.after(() => hub.stop("cleanup").catch(() => {}));
  const abrupt = net.createConnection(sock); abrupt.on("error", () => {});
  t.after(() => abrupt.destroy());
  await new Promise((r) => abrupt.once("connect", r)); abrupt.destroy();
  const partial = net.createConnection(sock); partial.on("error", () => {});
  t.after(() => partial.destroy());
  await new Promise((r) => partial.once("connect", r)); partial.write('{"type":"hel'); partial.destroy();
  const garbage = rawClient(sock); await new Promise((r) => garbage.sock.once("connect", r));
  t.after(() => garbage.sock.destroy());
  garbage.send({ type: "tool_request", id: 1, tool: "x" });
  await waitFor(() => garbage.lines.some((l) => l.type === "error"));
  const silent = rawClient(sock);
  t.after(() => silent.sock.destroy());
  await waitFor(() => silent.sock.destroyed || silent.sock.readyState === "closed", 2000);
  const big = net.createConnection(sock); big.on("error", () => {});
  t.after(() => big.destroy());
  await new Promise((r) => big.once("connect", r)); big.write("x".repeat(4096));
  await sleep(100);
  assert.equal(hub.state, "serving");
  const c = await helloClient(sock);
  t.after(() => c.sock.destroy());
  c.send({ type: "tool_request", id: "9", tool: "find", args: {} });
  await waitFor(() => ext.received.length === 1);
  await hub.stop("test");
});

test("a request over 1 MB is refused without reaching the extension", { timeout: 10000 }, async (t) => {
  const home = tmpHome();
  const { hub, ext } = await startHub(home);
  t.after(() => hub.stop("cleanup").catch(() => {}));
  const c = await helloClient(bridgePath(home));
  t.after(() => c.sock.destroy());
  c.send({ type: "tool_request", id: "1", tool: "javascript_tool", args: { text: "x".repeat(1_100_000) } });
  await waitFor(() => c.lines.some((l) => l.type === "tool_error"));
  assert.equal(c.lines.find((l) => l.type === "tool_error").error, "Request is too large for the browser channel (limit 1 MB).");
  assert.equal(ext.received.length, 0);
  await hub.stop("test");
});

test("a reply for a client that already left is dropped quietly", { timeout: 10000 }, async (t) => {
  const home = tmpHome();
  const { hub, ext } = await startHub(home);
  t.after(() => hub.stop("cleanup").catch(() => {}));
  const c = await helloClient(bridgePath(home));
  t.after(() => c.sock.destroy());
  c.send({ type: "tool_request", id: "1", tool: "find", args: {} });
  await waitFor(() => ext.received.length === 1);
  c.sock.destroy();
  await sleep(50);
  assert.doesNotThrow(() => ext.reply(ext.received[0], "late"));
  assert.equal(hub.state, "serving");
  await hub.stop("test");
});

test("a second hub waits in standby and takes over when the first stops", { timeout: 10000 }, async (t) => {
  const home = tmpHome();
  const first = await startHub(home);
  t.after(() => first.hub.stop("cleanup").catch(() => {}));
  const second = await startHub(home, { standbyRetryMs: 100 });
  t.after(() => second.hub.stop("cleanup").catch(() => {}));
  assert.equal(first.state, "serving");
  assert.equal(second.state, "standby");
  await first.hub.stop("test");
  await waitFor(() => second.hub.state === "serving", 2000);
  const c = await helloClient(bridgePath(home));
  t.after(() => c.sock.destroy());
  c.send({ type: "tool_request", id: "1", tool: "find", args: {} });
  await waitFor(() => second.ext.received.length === 1);
  await second.hub.stop("test");
});

test("a stale socket left by a killed hub is replaced", { timeout: 15000 }, async (t) => {
  const home = tmpHome();
  const sock = bridgePath(home);
  fs.mkdirSync(sock.replace(/\/bridge\.sock$/, ""), { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, ["--input-type=commonjs", "-e",
    "require('net').createServer().listen(process.argv[1]); setInterval(() => {}, 1000);", sock], { stdio: "ignore" });
  t.after(() => { try { child.kill("SIGKILL"); } catch {} });
  await waitFor(() => fs.existsSync(sock));
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  assert.ok(fs.existsSync(sock), "killed process leaves its socket file behind");
  const { hub, state } = await startHub(home);
  t.after(() => hub.stop("cleanup").catch(() => {}));
  assert.equal(state, "serving");
  await hub.stop("test");
});

test("a non-socket file at the socket path is refused and left alone", { timeout: 10000 }, async () => {
  const home = tmpHome();
  const sock = bridgePath(home);
  fs.mkdirSync(sock.replace(/\/bridge\.sock$/, ""), { recursive: true, mode: 0o700 });
  fs.writeFileSync(sock, "not a socket");
  await assert.rejects(startHub(home), BridgeSecurityError);
  assert.equal(fs.readFileSync(sock, "utf8"), "not a socket");
});

test("the socket is 0600 and stop() only removes a socket that is still ours", { timeout: 10000 }, async (t) => {
  const home = tmpHome();
  const sock = bridgePath(home);
  const a = await startHub(home);
  t.after(() => a.hub.stop("cleanup").catch(() => {}));
  assert.equal(fs.statSync(sock).mode & 0o777, 0o600);
  fs.unlinkSync(sock);
  const b = await startHub(home);
  t.after(() => b.hub.stop("cleanup").catch(() => {}));
  await a.hub.stop("test");
  assert.ok(fs.existsSync(sock), "hub A must not delete hub B's socket");
  await b.hub.stop("test");
  assert.ok(!fs.existsSync(sock));
});

// --- Fix round: I1, I2, I3, M1, M3, M4 --------------------------------------

test("stop() closes a silent pre-hello peer instead of waiting out its hello timeout", { timeout: 10000 }, async (t) => {
  const home = tmpHome();
  const { hub } = await startHub(home, { helloTimeoutMs: 2000 });
  t.after(() => hub.stop("cleanup").catch(() => {}));
  const silent = net.createConnection(bridgePath(home)); silent.on("error", () => {});
  t.after(() => silent.destroy());
  await new Promise((r) => silent.once("connect", r));
  await sleep(20);
  const t0 = Date.now();
  await hub.stop("test");
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1000, `stop() took ${elapsed}ms, expected well under the 2000ms hello timeout`);
  // stop() destroying the hub-side socket needs a moment to reach the peer.
  await waitFor(() => silent.destroyed || silent.readyState === "closed", 1000);
});

test("a hello sent after stop() begins is refused, nothing reaches the extension, and stop() still resolves promptly", { timeout: 10000 }, async (t) => {
  const home = tmpHome();
  const { hub, ext } = await startHub(home);
  const p = rawClient(bridgePath(home));
  t.after(() => p.sock.destroy());
  await new Promise((r) => p.sock.once("connect", r));
  await sleep(20);
  const t0 = Date.now();
  const stopP = hub.stop("test");
  p.send({ type: "hello", protocol: 2, pid: 1, ppid: 1, cwd: "/w", label: "late" });
  await sleep(50);
  p.send({ type: "tool_request", id: "1", tool: "computer", args: {} });
  await stopP;
  assert.ok(Date.now() - t0 < 1000, "stop() must resolve promptly even with a late hello arriving");
  await sleep(50);
  assert.ok(!p.lines.some((l) => l.type === "welcome"), "a late hello must not be welcomed");
  assert.equal(ext.received.length, 0, "nothing may reach the extension after stop() begins");
});

test("stop() never removes or replaces the socket of a hub that currently owns the path", { timeout: 10000 }, async (t) => {
  const home = tmpHome();
  const sock = bridgePath(home);
  const A = await startHub(home, { helloTimeoutMs: 1500 });
  t.after(() => A.hub.stop("cleanup").catch(() => {}));
  const silent = net.createConnection(sock); silent.on("error", () => {});
  t.after(() => silent.destroy());
  await new Promise((r) => silent.once("connect", r));
  fs.unlinkSync(sock);
  const B = await startHub(home);
  t.after(() => B.hub.stop("cleanup").catch(() => {}));
  const inoB = fs.statSync(sock).ino;
  const C = await startHub(home, { standbyRetryMs: 50 });
  t.after(() => C.hub.stop("cleanup").catch(() => {}));
  assert.equal(C.state, "standby");
  await A.hub.stop("test");
  await sleep(150);
  assert.equal(fs.statSync(sock).ino, inoB, "B's socket must survive A.stop()");
  assert.equal(B.hub.state, "serving");
  assert.notEqual(C.hub.state, "serving", "C must not end up claiming to serve an unreachable path");
  const c = await helloClient(sock);
  t.after(() => c.sock.destroy());
  c.send({ type: "tool_request", id: "1", tool: "find", args: {} });
  await waitFor(() => B.ext.received.length === 1);
  assert.equal(C.ext.received.length, 0);
});

test("two hubs starting at the same instant against a stale socket: exactly one serves, every time", { timeout: 20000 }, async (t) => {
  for (let i = 0; i < 5; i++) {
    const home = tmpHome();
    const sock = bridgePath(home);
    fs.mkdirSync(sock.replace(/\/bridge\.sock$/, ""), { recursive: true, mode: 0o700 });
    const child = spawn(process.execPath, ["--input-type=commonjs", "-e",
      "require('net').createServer().listen(process.argv[1]); setInterval(() => {}, 1000);", sock], { stdio: "ignore" });
    t.after(() => { try { child.kill("SIGKILL"); } catch {} });
    await waitFor(() => fs.existsSync(sock));
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));

    const extB = fakeExtension();
    const extC = fakeExtension();
    const B = new BridgeHub({ sockPath: sock, sendToExtension: extB.send, standbyRetryMs: 100000 });
    const C = new BridgeHub({ sockPath: sock, sendToExtension: extC.send, standbyRetryMs: 100000 });
    extB.attach(B); extC.attach(C);
    t.after(() => Promise.all([B.stop("cleanup").catch(() => {}), C.stop("cleanup").catch(() => {})]));
    const [sb, sc] = await Promise.all([B.start(), C.start()]);
    assert.ok((sb === "serving") !== (sc === "serving"), `iteration ${i}: exactly one of B/C must serve (got B=${sb}, C=${sc})`);

    const c = await helloClient(sock);
    c.send({ type: "tool_request", id: "1", tool: "find", args: {} });
    await waitFor(() => extB.received.length + extC.received.length === 1);
    c.sock.destroy();
    await B.stop("test"); await C.stop("test");
  }
});

test("a serving hub notices it was displaced and serves again within selfCheckMs", { timeout: 10000 }, async (t) => {
  const home = tmpHome();
  const sock = bridgePath(home);
  const { hub, ext } = await startHub(home, { selfCheckMs: 100 });
  t.after(() => hub.stop("cleanup").catch(() => {}));
  const inoBefore = fs.statSync(sock).ino;
  fs.unlinkSync(sock);
  await waitFor(() => fs.existsSync(sock) && fs.statSync(sock).ino !== inoBefore, 2000);
  assert.equal(hub.state, "serving");
  const c = await helloClient(sock);
  t.after(() => c.sock.destroy());
  c.send({ type: "tool_request", id: "1", tool: "find", args: {} });
  await waitFor(() => ext.received.length === 1);
});

test("stop() called while start() is still in flight resolves start() as \"stopped\" and nothing keeps listening", { timeout: 10000 }, async (t) => {
  const home = tmpHome();
  const A = await startHub(home); // occupies the path so B's start() goes through the probe/link-retry path
  t.after(() => A.hub.stop("cleanup").catch(() => {}));
  const extB = fakeExtension();
  const B = new BridgeHub({ sockPath: bridgePath(home), sendToExtension: extB.send, standbyRetryMs: 50 });
  extB.attach(B);
  t.after(() => B.stop("cleanup").catch(() => {}));
  const startP = B.start();
  await B.stop("test");
  const startResult = await startP;
  assert.equal(startResult, "stopped");
  assert.equal(B.state, "stopped");
  await sleep(200); // give any lingering retry/standby logic a chance to misbehave
  assert.equal(B.state, "stopped", "state must not flip back to standby/serving after stop()");
  assert.ok(!B._server || !B._server.listening, "B must not be left listening after an aborted start()");
  const leftover = fs.readdirSync(bridgeDir(home)).filter((f) => f !== "bridge.sock");
  assert.deepEqual(leftover, [], "no stray temp socket files after an aborted start()");
});

test("after \"Expected hello.\" the hub ignores anything else from that peer, even a later valid hello", { timeout: 10000 }, async (t) => {
  const home = tmpHome();
  const events = [];
  const { hub, ext } = await startHub(home, { log: (e) => events.push(e) });
  t.after(() => hub.stop("cleanup").catch(() => {}));
  // allowHalfOpen keeps the peer's read side open after the hub's end() sends
  // a FIN, so its later writes actually reach the hub instead of the whole
  // connection auto-closing first (matches the reviewer's probe technique).
  const sock = net.createConnection(bridgePath(home));
  sock.allowHalfOpen = true;
  sock.on("error", () => {});
  t.after(() => sock.destroy());
  const lines = []; let buf = "";
  sock.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) !== -1) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  await new Promise((r) => sock.once("connect", r));
  sock.write(JSON.stringify({ type: "nope" }) + "\n"); // triggers "Expected hello." + end()
  await waitFor(() => lines.some((l) => l.type === "error"));
  sock.write(JSON.stringify({ type: "hello", protocol: 2, pid: 1, ppid: 1, cwd: "/w", label: "late" }) + "\n");
  sock.write(JSON.stringify({ type: "tool_request", id: "1", tool: "find", args: {} }) + "\n");
  await sleep(150);
  // Check the internal signal directly: a Node stream quirk (write-after-end
  // failing silently) can make the peer's own view look clean even when the
  // hub internally still accepted the late hello, so client-observable lines
  // alone are not a reliable check here.
  assert.ok(!events.includes("client_connected"), "a hello after rejection must never be accepted, even internally");
  assert.equal(ext.received.length, 0, "nothing may be forwarded from a rejected peer");
});

test("an oversized line destroys the connection quickly, proving the length check rather than the hello timer", { timeout: 10000 }, async (t) => {
  const home = tmpHome();
  const { hub } = await startHub(home, { helloTimeoutMs: 5000, maxLineBytes: 1024 });
  t.after(() => hub.stop("cleanup").catch(() => {}));
  const sock = bridgePath(home);
  const big = net.createConnection(sock); big.on("error", () => {});
  t.after(() => big.destroy());
  await new Promise((r) => big.once("connect", r));
  const t0 = Date.now();
  big.write("x".repeat(4096)); // no newline
  await waitFor(() => big.destroyed, 2000);
  assert.ok(Date.now() - t0 < 500, "the oversized line must be caught well before the 5000ms hello timer");
});

test('a tool_request without a tool string gets "Malformed request."', { timeout: 10000 }, async (t) => {
  const home = tmpHome();
  const { hub, ext } = await startHub(home);
  t.after(() => hub.stop("cleanup").catch(() => {}));
  const c = await helloClient(bridgePath(home));
  t.after(() => c.sock.destroy());
  c.send({ type: "tool_request", id: "1", args: {} }); // missing tool
  await waitFor(() => c.lines.some((l) => l.type === "tool_error"));
  assert.equal(c.lines.find((l) => l.type === "tool_error").error, "Malformed request.");
  assert.equal(ext.received.length, 0);
});

test('sending the same request id twice while the first is pending gets "Duplicate request id." for the second', { timeout: 10000 }, async (t) => {
  const home = tmpHome();
  const { hub, ext } = await startHub(home);
  t.after(() => hub.stop("cleanup").catch(() => {}));
  const c = await helloClient(bridgePath(home));
  t.after(() => c.sock.destroy());
  c.send({ type: "tool_request", id: "1", tool: "find", args: {} });
  c.send({ type: "tool_request", id: "1", tool: "find", args: {} });
  await waitFor(() => c.lines.some((l) => l.type === "tool_error"));
  assert.equal(c.lines.find((l) => l.type === "tool_error").error, "Duplicate request id.");
  await sleep(50);
  assert.equal(ext.received.length, 1, "the extension must receive exactly one request");
});

// --- Re-review round 2: temp-name path length, rejected half-open peer -----

test("a sockPath at the platform's maximum length still serves (the temp placement name must not overflow it)", { timeout: 10000 }, async (t) => {
  const maxLen = process.platform === "linux" ? 107 : 103;
  const suffixLen = bridgePath("X").length - 1; // fixed length path.join adds beyond home
  const targetHomeLen = maxLen - suffixLen;
  const base = tmpHome();
  const fillerLen = targetHomeLen - base.length - 1; // -1 for path.join's separator
  assert.ok(fillerLen > 0, "tmpHome() base is already too long to hit the target length in this test");
  const home = path.join(base, "a".repeat(fillerLen));
  fs.mkdirSync(home, { recursive: true });
  const sock = bridgePath(home);
  assert.equal(Buffer.byteLength(sock), maxLen, "test setup sanity: sockPath must be exactly at the platform maximum");

  const { hub, ext, state } = await startHub(home);
  t.after(() => hub.stop("cleanup").catch(() => {}));
  assert.equal(state, "serving");
  const c = await helloClient(sock);
  t.after(() => c.sock.destroy());
  c.send({ type: "tool_request", id: "1", tool: "find", args: {} });
  await waitFor(() => ext.received.length === 1);
});

test("a rejected peer that stays half-open is destroyed within a bounded time, not left dangling until stop()", { timeout: 10000 }, async (t) => {
  const home = tmpHome();
  const { hub } = await startHub(home);
  t.after(() => hub.stop("cleanup").catch(() => {}));
  // allowHalfOpen keeps the peer's read side open after the hub's end() sends
  // a FIN, so it would otherwise sit connected (and tracked) forever. Once a
  // Unix socket's readable side has ended, the peer that still holds its
  // writable side open gets no passive signal that the far end later fully
  // destroyed its own end (no pending read/write to surface it on) — so this
  // checks the hub's own bookkeeping directly rather than the peer's socket.
  const sock = net.createConnection(bridgePath(home));
  sock.allowHalfOpen = true;
  sock.on("error", () => {});
  t.after(() => sock.destroy());
  await new Promise((r) => sock.once("connect", r));
  sock.write(JSON.stringify({ type: "nope" }) + "\n");
  await waitFor(() => hub._conns.size === 0, 2000);
});

// --- Task 5 (H5): M2 deferred logging ---------------------------------------

test("a persistent standby-retry failure logs standby_retry_failed once, not every retry", { timeout: 10000 }, async (t) => {
  const home = tmpHome();
  const sock = bridgePath(home);
  const first = await startHub(home);
  t.after(() => first.hub.stop("cleanup").catch(() => {}));
  const events = [];
  const second = new BridgeHub({ sockPath: sock, sendToExtension: () => {}, standbyRetryMs: 50, log: (event, data) => events.push({ event, data }) });
  t.after(() => second.stop("cleanup").catch(() => {}));
  assert.equal(await second.start(), "standby");
  // Replace the still-live socket with a non-socket file. Unlinking a path
  // never touches an already-open Unix socket, so A keeps serving unaffected,
  // but every future standby-retry attempt by B now sees a non-socket file at
  // sockPath and rejects with BridgeSecurityError.
  fs.unlinkSync(sock);
  fs.writeFileSync(sock, "not a socket");
  await waitFor(() => events.some((e) => e.event === "standby_retry_failed"), 2000);
  await sleep(250); // several more 50ms retry cycles against the same failure
  const failures = events.filter((e) => e.event === "standby_retry_failed");
  assert.equal(failures.length, 1, "a persistent identical failure must log exactly once");
  assert.match(failures[0].data.message, /non-socket/);
});

test("self_check_failed and its trailing standby retries throttle by message, and reset after recovery", { timeout: 15000 }, async (t) => {
  const home = tmpHome();
  const sock = bridgePath(home);
  const events = [];
  const { hub } = await startHub(home, { selfCheckMs: 100, standbyRetryMs: 50, log: (event, data) => events.push({ event, data }) });
  t.after(() => hub.stop("cleanup").catch(() => {}));

  fs.unlinkSync(sock);
  fs.writeFileSync(sock, "not a socket");
  await waitFor(() => events.some((e) => e.event === "self_check_failed"), 2000);
  await sleep(250); // several more 50ms standby-retry cycles against the same failure
  assert.equal(events.filter((e) => e.event === "self_check_failed").length, 1, "the self-check's own reacquire attempt logs once");
  assert.equal(events.filter((e) => e.event === "standby_retry_failed").length, 1, "the standby retries that follow must also throttle to one log");

  // Recovery clears both throttles: an identical later failure must log again.
  fs.unlinkSync(sock);
  await waitFor(() => hub.state === "serving", 2000);
  fs.unlinkSync(sock);
  fs.writeFileSync(sock, "not a socket");
  await waitFor(() => events.filter((e) => e.event === "self_check_failed").length === 2, 2000);
});

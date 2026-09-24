import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import { spawn } from "node:child_process";
import { bridgePath } from "../bridge-endpoint.js";
import { BridgeSecurityError } from "../bridge-endpoint.js";
import { tmpHome, startHub, waitFor, sleep } from "./helpers.mjs";

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

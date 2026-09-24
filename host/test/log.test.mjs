import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createLogger } from "../log.js";
import { tmpHome, waitFor, cleanupTmpDirs } from "./helpers.mjs";

after(cleanupTmpDirs);

const logDir = (home) => path.join(home, ".config", "open-claude-in-chrome", "logs");
const logFile = (home, name) => path.join(logDir(home), `${name}.log`);
const lines = (f) => fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("appends structured lines with private permissions", () => {
  const home = tmpHome();
  const log = createLogger("unit", { home });
  log.info("start", { cwd: "/w" });
  log.error("exit", { reason: "stdin closed" });
  const l = lines(logFile(home, "unit"));
  assert.equal(l.length, 2);
  assert.equal(l[0].event, "start");
  assert.equal(l[1].level, "error");
  assert.equal(typeof l[0].ts, "string");
  assert.equal(fs.statSync(logFile(home, "unit")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(logDir(home)).mode & 0o777, 0o700, "a freshly created logs dir is private");
});

test("fixed fields (ts, pid, name, level, event) always win over a same-named payload key", () => {
  const home = tmpHome();
  const log = createLogger("unit2", { home });
  const before = Date.now();
  log.info("myevent", { pid: 999999, ts: "not-a-real-timestamp", event: "not-the-real-event", foo: "bar" });
  const l = lines(logFile(home, "unit2"));
  assert.equal(l.length, 1);
  assert.equal(l[0].pid, process.pid, "the writer's own pid wins over a payload pid");
  assert.equal(l[0].event, "myevent", "the real event name wins over a payload event key");
  assert.ok(!Number.isNaN(Date.parse(l[0].ts)) && Date.parse(l[0].ts) >= before, "a real ISO timestamp wins over a payload ts");
  assert.equal(l[0].foo, "bar", "a non-colliding payload key still comes through");
});

test("rotates past maxBytes", () => {
  const home = tmpHome();
  const log = createLogger("rot", { home, maxBytes: 200 });
  for (let i = 0; i < 20; i++) log.info("tick", { i });
  assert.ok(fs.existsSync(logFile(home, "rot") + ".1"));
  assert.ok(fs.statSync(logFile(home, "rot")).size <= 400);
});

test("never throws when the log directory cannot be written", () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, ".config", "open-claude-in-chrome"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config", "open-claude-in-chrome", "logs"), "file, not dir");
  assert.doesNotThrow(() => createLogger("x", { home }).info("start"));
});

test("the native host records why it exited", { timeout: 10000 }, async (t) => {
  const home = tmpHome();
  const proc = spawn(process.execPath, [path.join(import.meta.dirname, "..", "native-host.js")], { env: { ...process.env, HOME: home }, stdio: ["pipe", "ignore", "ignore"] });
  t.after(() => { try { proc.kill("SIGKILL"); } catch {} });
  await waitFor(() => fs.existsSync(logFile(home, "native-host")));
  proc.stdin.end();
  await new Promise((r) => proc.once("exit", r));
  const exit = lines(logFile(home, "native-host")).find((l) => l.event === "exit");
  assert.equal(exit.reason, "stdin closed");
});

test("the native host's start payload carries the real version and node version", { timeout: 10000 }, async (t) => {
  const home = tmpHome();
  const proc = spawn(process.execPath, [path.join(import.meta.dirname, "..", "native-host.js")], { env: { ...process.env, HOME: home }, stdio: ["pipe", "ignore", "ignore"] });
  t.after(() => { try { proc.kill("SIGKILL"); } catch {} });
  await waitFor(() => fs.existsSync(logFile(home, "native-host")));
  const start = lines(logFile(home, "native-host")).find((l) => l.event === "start");
  const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8"));
  assert.equal(start.version, pkg.version);
  assert.equal(start.node, process.version);
  proc.stdin.end();
  await new Promise((r) => proc.once("exit", r));
});

test("mcp-server records \"stdin closed\" as its exit reason", { timeout: 10000 }, async (t) => {
  const home = tmpHome();
  const proc = spawn(process.execPath, [path.join(import.meta.dirname, "..", "mcp-server.js")], { env: { ...process.env, HOME: home }, stdio: ["pipe", "ignore", "ignore"] });
  t.after(() => { try { proc.kill("SIGKILL"); } catch {} });
  await waitFor(() => fs.existsSync(logFile(home, "mcp-server")));
  proc.stdin.end();
  await new Promise((r) => proc.once("exit", r));
  const exit = lines(logFile(home, "mcp-server")).find((l) => l.event === "exit");
  assert.equal(exit.reason, "stdin closed");
});

test("mcp-server records the signal name as its exit reason", { timeout: 10000 }, async (t) => {
  const home = tmpHome();
  const proc = spawn(process.execPath, [path.join(import.meta.dirname, "..", "mcp-server.js")], { env: { ...process.env, HOME: home }, stdio: ["pipe", "ignore", "ignore"] });
  t.after(() => { try { proc.kill("SIGKILL"); } catch {} });
  await waitFor(() => fs.existsSync(logFile(home, "mcp-server")));
  proc.kill("SIGTERM");
  await new Promise((r) => proc.once("exit", r));
  const exit = lines(logFile(home, "mcp-server")).find((l) => l.event === "exit");
  assert.equal(exit.reason, "SIGTERM");
});

test("12 concurrent processes rotating and appending at once: no dropped lines, .1 keeps the complete seed", { timeout: 20000 }, async (t) => {
  const home = tmpHome();
  const name = "burst";
  const maxBytes = 20000;
  const CHILD_COUNT = 12;

  // Seed the log just under maxBytes, so the burst of new writes below (not
  // the seed alone) is what pushes it over the limit and triggers rotation
  // mid-burst — reproducing the reviewer's race. maxBytes is picked large
  // relative to the 24 lines the burst can add (~100 bytes each, ~2.4KB
  // total) so a second rotation cannot happen inside this same burst.
  fs.mkdirSync(logDir(home), { recursive: true, mode: 0o700 });
  const seedLines = [];
  let seedSize = 0;
  for (let i = 0; ; i++) {
    const line = JSON.stringify({ seed: true, i, pad: "s".repeat(60) }) + "\n";
    if (seedSize + Buffer.byteLength(line) > maxBytes - 300) break;
    seedLines.push(line);
    seedSize += Buffer.byteLength(line);
  }
  const seedContent = seedLines.join("");
  fs.writeFileSync(logFile(home, name), seedContent);

  const logJsUrl = pathToFileURL(path.join(import.meta.dirname, "..", "log.js")).href;
  const CHILD_SRC = [
    `import { createLogger } from ${JSON.stringify(logJsUrl)};`,
    // argv[0] is the node executable itself even with "-e ... -- a b"; the
    // extra positional args start at argv[1].
    `const log = createLogger(process.argv[1], { maxBytes: Number(process.argv[2]) });`,
    `process.stdout.write("ready\\n");`,
    `process.stdin.resume();`,
    `process.stdin.once("data", () => {`,
    `  log.info("burst", { from: process.pid, n: 0 });`,
    `  log.info("burst", { from: process.pid, n: 1 });`,
    `  process.exit(0);`,
    `});`,
  ].join("\n");

  const children = [];
  for (let c = 0; c < CHILD_COUNT; c++) {
    children.push(spawn(process.execPath, ["--input-type=module", "-e", CHILD_SRC, "--", name, String(maxBytes)], {
      env: { ...process.env, HOME: home },
      stdio: ["pipe", "pipe", "ignore"],
    }));
  }
  t.after(() => { for (const c of children) { try { c.kill("SIGKILL"); } catch {} } });

  // Wait for every child to have created its logger and attached its stdin
  // listener before releasing any of them, so the release below lands on
  // all 12 as close to "at the same moment" as this process can arrange.
  await Promise.all(children.map((c) => new Promise((resolve) => {
    let buf = "";
    c.stdout.on("data", (d) => { buf += d; if (buf.includes("ready")) resolve(); });
  })));

  const exited = Promise.all(children.map((c) => new Promise((resolve) => c.once("exit", resolve))));
  for (const c of children) c.stdin.write("go\n"); // tight loop: as close to "at once" as JS allows
  await exited;

  const mainContent = fs.readFileSync(logFile(home, name), "utf8");
  const rotatedFile = logFile(home, name) + ".1";
  assert.ok(fs.existsSync(rotatedFile), "the burst must have triggered a rotation");
  const rotatedContent = fs.readFileSync(rotatedFile, "utf8");
  assert.ok(rotatedContent.startsWith(seedContent), ".1 must start with the complete, uncorrupted seed content");
  assert.ok(!fs.existsSync(logFile(home, name) + ".2"), "maxBytes and line sizes were chosen so a second rotation cannot happen inside the burst");

  const burstLines = (mainContent + rotatedContent).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.event === "burst");
  assert.equal(burstLines.length, CHILD_COUNT * 2, "all 24 lines from the 12 processes must be present across the log and .1, none dropped");
  const perProcess = new Map();
  for (const l of burstLines) perProcess.set(l.from, (perProcess.get(l.from) || 0) + 1);
  assert.equal(perProcess.size, CHILD_COUNT, "each of the 12 processes must be represented");
  for (const count of perProcess.values()) assert.equal(count, 2, "each process's both lines must be present");
});

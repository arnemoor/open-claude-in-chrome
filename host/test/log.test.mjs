import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createLogger } from "../log.js";
import { tmpHome, waitFor } from "./helpers.mjs";

const logFile = (home, name) => path.join(home, ".config", "open-claude-in-chrome", "logs", `${name}.log`);
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

test("the native host records why it exited", async () => {
  const home = tmpHome();
  const proc = spawn(process.execPath, [path.join(import.meta.dirname, "..", "native-host.js")], { env: { ...process.env, HOME: home }, stdio: ["pipe", "ignore", "ignore"] });
  await waitFor(() => fs.existsSync(logFile(home, "native-host")));
  proc.stdin.end();
  await new Promise((r) => proc.once("exit", r));
  const exit = lines(logFile(home, "native-host")).find((l) => l.event === "exit");
  assert.equal(exit.reason, "stdin closed");
});

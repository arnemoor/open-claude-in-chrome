import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadUploadPolicy, checkUploadPaths } from "../upload-policy.js";

function home() {
  const h = fs.mkdtempSync("/tmp/ocic-");
  fs.mkdirSync(path.join(h, "Downloads"));
  fs.mkdirSync(path.join(h, ".config", "open-claude-in-chrome"), { recursive: true });
  fs.writeFileSync(path.join(h, "Downloads", "ok.txt"), "ok");
  fs.writeFileSync(path.join(h, "secret.txt"), "secret");
  return h;
}

test("a file in Downloads is allowed and resolved", () => {
  const h = home();
  const r = checkUploadPaths([path.join(h, "Downloads", "ok.txt")], loadUploadPolicy({ home: h }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.resolved, [fs.realpathSync(path.join(h, "Downloads", "ok.txt"))]);
});

test("files outside the allowed folders are rejected", () => {
  const h = home();
  const r = checkUploadPaths([path.join(h, "secret.txt")], loadUploadPolicy({ home: h, tmpDirs: [] }));
  assert.equal(r.ok, false);
  assert.match(r.error, /Not in an allowed upload folder/);
  assert.match(r.error, /fileUploadAllowedDirs/);
});

test("a symlink inside Downloads that points outside is rejected", () => {
  const h = home();
  fs.symlinkSync(path.join(h, "secret.txt"), path.join(h, "Downloads", "link.txt"));
  const r = checkUploadPaths([path.join(h, "Downloads", "link.txt")], loadUploadPolicy({ home: h, tmpDirs: [] }));
  assert.equal(r.ok, false);
});

test("relative, tilde, missing and directory paths are rejected", () => {
  const h = home();
  const p = loadUploadPolicy({ home: h });
  assert.match(checkUploadPaths(["ok.txt"], p).error, /must be absolute/);
  assert.match(checkUploadPaths(["~/Downloads/ok.txt"], p).error, /must be absolute/);
  assert.match(checkUploadPaths([path.join(h, "Downloads", "nope.txt")], p).error, /File not found/);
  assert.match(checkUploadPaths([path.join(h, "Downloads")], p).error, /Not a regular file/);
});

test("one bad path rejects the whole call", () => {
  const h = home();
  const r = checkUploadPaths([path.join(h, "Downloads", "ok.txt"), path.join(h, "secret.txt")], loadUploadPolicy({ home: h, tmpDirs: [] }));
  assert.equal(r.ok, false);
});

test("combined size over 10 MB is rejected", () => {
  const h = home();
  const a = path.join(h, "Downloads", "a.bin");
  const b = path.join(h, "Downloads", "b.bin");
  fs.writeFileSync(a, Buffer.alloc(6 * 1024 * 1024));
  fs.writeFileSync(b, Buffer.alloc(6 * 1024 * 1024));
  assert.match(checkUploadPaths([a, b], loadUploadPolicy({ home: h })).error, /exceeds the 10 MB limit/);
});

test("fileUploadAllowedDirs replaces the defaults", () => {
  const h = home();
  fs.mkdirSync(path.join(h, "work"));
  fs.writeFileSync(path.join(h, "work", "w.txt"), "w");
  fs.writeFileSync(path.join(h, ".config", "open-claude-in-chrome", "config.json"), JSON.stringify({ fileUploadAllowedDirs: ["~/work"] }));
  const p = loadUploadPolicy({ home: h });
  assert.equal(checkUploadPaths([path.join(h, "work", "w.txt")], p).ok, true);
  assert.equal(checkUploadPaths([path.join(h, "Downloads", "ok.txt")], p).ok, false);
});

// Pins the production defaults: with no tmpDirs override, the system temp
// folders are included alongside the HOME-derived Downloads dir.
test("defaults include the HOME Downloads dir plus the system temp folders", () => {
  const h = home();
  const p = loadUploadPolicy({ home: h });
  assert.ok(p.allowedDirs.includes(fs.realpathSync(path.join(h, "Downloads"))));
  assert.ok(p.allowedDirs.includes(fs.realpathSync(os.tmpdir())));
  assert.ok(p.allowedDirs.includes(fs.realpathSync("/tmp")));
});

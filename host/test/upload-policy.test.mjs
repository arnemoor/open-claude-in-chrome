import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadUploadPolicy, checkUploadPaths } from "../upload-policy.js";
import { mkdtemp, cleanupTmpDirs } from "./helpers.mjs";

after(cleanupTmpDirs);

function home() {
  const h = mkdtemp();
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
  const r = checkUploadPaths([path.join(h, "secret.txt")], loadUploadPolicy({ home: h }));
  assert.equal(r.ok, false);
  assert.match(r.error, /Not in an allowed upload folder/);
  assert.match(r.error, /fileUploadAllowedDirs/);
});

test("a symlink inside Downloads that points outside is rejected", () => {
  const h = home();
  fs.symlinkSync(path.join(h, "secret.txt"), path.join(h, "Downloads", "link.txt"));
  const r = checkUploadPaths([path.join(h, "Downloads", "link.txt")], loadUploadPolicy({ home: h }));
  assert.equal(r.ok, false);
  assert.match(r.error, /Not in an allowed upload folder/);
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
  const r = checkUploadPaths([path.join(h, "Downloads", "ok.txt"), path.join(h, "secret.txt")], loadUploadPolicy({ home: h }));
  assert.equal(r.ok, false);
  assert.match(r.error, /Not in an allowed upload folder/);
});

test("combined size over 10 MB is rejected", () => {
  const h = home();
  try {
    const a = path.join(h, "Downloads", "a.bin");
    const b = path.join(h, "Downloads", "b.bin");
    fs.writeFileSync(a, Buffer.alloc(6 * 1024 * 1024));
    fs.writeFileSync(b, Buffer.alloc(6 * 1024 * 1024));
    assert.match(checkUploadPaths([a, b], loadUploadPolicy({ home: h })).error, /exceeds the 10 MB limit/);
  } finally {
    fs.rmSync(h, { recursive: true, force: true });
  }
});

test("combined size at exactly 10 MB is accepted, one byte over is rejected", () => {
  const h = home();
  try {
    const a = path.join(h, "Downloads", "a.bin");
    const b = path.join(h, "Downloads", "b.bin");
    fs.writeFileSync(a, Buffer.alloc(5 * 1024 * 1024));
    fs.writeFileSync(b, Buffer.alloc(5 * 1024 * 1024));
    const p = loadUploadPolicy({ home: h });
    assert.equal(checkUploadPaths([a, b], p).ok, true);
    fs.appendFileSync(b, Buffer.alloc(1));
    assert.match(checkUploadPaths([a, b], p).error, /exceeds the 10 MB limit/);
  } finally {
    fs.rmSync(h, { recursive: true, force: true });
  }
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

// Pins the production defaults: ~/Downloads and ~/Desktop only. The system
// temp folders are deliberately NOT defaults (they expose other sessions'
// data, e.g. other Claude Code sessions' scratch dirs under $TMPDIR).
test("defaults are exactly the HOME's Downloads and Desktop, never the system temp folders", () => {
  const h = home();
  fs.mkdirSync(path.join(h, "Desktop"));
  const p = loadUploadPolicy({ home: h });
  assert.deepEqual(p.allowedDirs, [
    fs.realpathSync(path.join(h, "Downloads")),
    fs.realpathSync(path.join(h, "Desktop")),
  ]);
  assert.ok(!p.allowedDirs.includes(fs.realpathSync("/tmp")));
  assert.ok(!p.allowedDirs.includes(fs.realpathSync(os.tmpdir())));
});

test("a relative fileUploadAllowedDirs entry is ignored with a warning, and an empty allowlist says so plainly", () => {
  const h = home();
  fs.writeFileSync(path.join(h, ".config", "open-claude-in-chrome", "config.json"), JSON.stringify({ fileUploadAllowedDirs: ["not/absolute"] }));
  const warnings = [];
  const p = loadUploadPolicy({ home: h, warn: (m) => warnings.push(m) });
  assert.deepEqual(p.allowedDirs, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /not\/absolute/);

  const r = checkUploadPaths([path.join(h, "Downloads", "ok.txt")], p);
  assert.equal(r.ok, false);
  assert.match(r.error, /No upload folder is allowed/);
  assert.doesNotMatch(r.error, /Allowed folders: \./);
});

test("non-string fileUploadAllowedDirs entries are each ignored with a warning; valid entries still work", () => {
  const h = home();
  fs.writeFileSync(
    path.join(h, ".config", "open-claude-in-chrome", "config.json"),
    JSON.stringify({ fileUploadAllowedDirs: [42, null, {}, "~/Downloads"] })
  );
  const warnings = [];
  const p = loadUploadPolicy({ home: h, warn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 3);
  assert.equal(checkUploadPaths([path.join(h, "Downloads", "ok.txt")], p).ok, true);
});

test("a symlink to a directory inside Downloads reports the symlink's own path, not its target", () => {
  const h = home();
  fs.mkdirSync(path.join(h, "Downloads", "dir"));
  const dirlink = path.join(h, "Downloads", "dirlink");
  fs.symlinkSync(path.join(h, "Downloads", "dir"), dirlink);
  const r = checkUploadPaths([dirlink], loadUploadPolicy({ home: h }));
  assert.equal(r.ok, false);
  assert.ok(r.error.startsWith(`Not a regular file: ${dirlink}.`), r.error);
});

test("a config with a JSON syntax error fails closed and names the reason", () => {
  const h = home();
  fs.writeFileSync(
    path.join(h, ".config", "open-claude-in-chrome", "config.json"),
    '{ "fileUploadAllowedDirs": ["~/work"], }'
  );
  const warnings = [];
  const p = loadUploadPolicy({ home: h, warn: (m) => warnings.push(m) });
  assert.deepEqual(p.allowedDirs, []);
  assert.equal(warnings.length, 1);

  const r = checkUploadPaths([path.join(h, "Downloads", "ok.txt")], p);
  assert.equal(r.ok, false);
  assert.match(r.error, /Upload policy config is invalid/);
  assert.match(r.error, /no folder is allowed/);
});

test("a config with a non-array fileUploadAllowedDirs fails closed and names the reason", () => {
  const h = home();
  fs.writeFileSync(
    path.join(h, ".config", "open-claude-in-chrome", "config.json"),
    JSON.stringify({ fileUploadAllowedDirs: "~/uploads" })
  );
  const p = loadUploadPolicy({ home: h });
  const r = checkUploadPaths([path.join(h, "Downloads", "ok.txt")], p);
  assert.equal(r.ok, false);
  assert.match(r.error, /Upload policy config is invalid/);
  assert.match(r.error, /fileUploadAllowedDirs/);
});

// M5: a typo'd key (missing the trailing "s") must not be silently read as
// fileUploadAllowedDirs, which would widen the allowlist with no warning.
test("an unknown top-level config key (e.g. a typo'd fileUploadAllowedDir) warns once and the defaults still apply", () => {
  const h = home();
  fs.mkdirSync(path.join(h, "work"));
  fs.writeFileSync(path.join(h, "work", "w.txt"), "w");
  fs.writeFileSync(
    path.join(h, ".config", "open-claude-in-chrome", "config.json"),
    JSON.stringify({ fileUploadAllowedDir: ["~/work"] })
  );
  const warnings = [];
  const p = loadUploadPolicy({ home: h, warn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 1, "one warning for the whole load, not one per key");
  assert.match(warnings[0], /fileUploadAllowedDir\b/);

  // The typo is simply unknown, not read as fileUploadAllowedDirs: it must not
  // silently widen who can reach ~/work (the regression ledger:150 guards against).
  assert.equal(checkUploadPaths([path.join(h, "work", "w.txt")], p).ok, false);
  assert.equal(checkUploadPaths([path.join(h, "Downloads", "ok.txt")], p).ok, true);
});

// Known keys must never warn, even together, and an unrecognized key still
// warns even when fileUploadAllowedDirs itself is also present and honored.
test("known keys (fileUploadAllowedDirs, the old port) never warn; an unknown key alongside a valid one still does", () => {
  const h = home();
  fs.writeFileSync(
    path.join(h, ".config", "open-claude-in-chrome", "config.json"),
    JSON.stringify({ fileUploadAllowedDirs: ["~/Downloads"], port: 18765 })
  );
  const noWarnings = [];
  loadUploadPolicy({ home: h, warn: (m) => noWarnings.push(m) });
  assert.equal(noWarnings.length, 0);

  fs.writeFileSync(
    path.join(h, ".config", "open-claude-in-chrome", "config.json"),
    JSON.stringify({ fileUploadAllowedDirs: ["~/Downloads"], typoKey: true })
  );
  const warnings = [];
  const p = loadUploadPolicy({ home: h, warn: (m) => warnings.push(m) });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /typoKey/);
  assert.equal(checkUploadPaths([path.join(h, "Downloads", "ok.txt")], p).ok, true);
});

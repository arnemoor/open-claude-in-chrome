// Covers install.sh's agent-skill symlink logic only (M9): does it relink,
// leave alone, or warn correctly for every combination of old-link shape
// (absolute/relative, existing/dangling) and repo (this one/another one)?
// Everything else install.sh does (native messaging manifests, npm install)
// runs unchanged against a temp HOME, exactly as a normal install would.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtemp, cleanupTmpDirs } from "./helpers.mjs";

after(cleanupTmpDirs);

const WORKTREE_DIR = path.join(import.meta.dirname, "..", "..");
const INSTALL_SH = path.join(WORKTREE_DIR, "install.sh");
const SKILL_SRC = path.join(WORKTREE_DIR, "skills", "open-claude-in-chrome");

// Mirrors install.sh's own repo_common_dir(): the same repo's worktrees
// (including this one) all share this common .git, so the parent of it is
// the root every worktree of this repo lives under.
function repoCommonDir(dir) {
  const out = execFileSync("git", ["-C", dir, "rev-parse", "--git-common-dir"], { encoding: "utf-8" }).trim();
  return path.isAbsolute(out) ? out : path.resolve(dir, out);
}
const MAIN_REPO_ROOT = path.dirname(repoCommonDir(WORKTREE_DIR));

function skillLink(home) {
  return path.join(home, ".claude", "skills", "open-claude-in-chrome");
}

function runInstall(home) {
  fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
  return execFileSync(INSTALL_SH, ["faketestextensionid"], {
    cwd: WORKTREE_DIR,
    env: { ...process.env, HOME: home },
    encoding: "utf-8",
  });
}

test("no existing link: creates a fresh symlink to this repo's skill", () => {
  const home = mkdtemp();
  const out = runInstall(home);
  assert.equal(fs.readlinkSync(skillLink(home)), SKILL_SRC);
  assert.match(out, /Linked skill:/);
});

test("a link already at the exact right target is relinked without complaint", () => {
  const home = mkdtemp();
  fs.mkdirSync(path.dirname(skillLink(home)), { recursive: true });
  fs.symlinkSync(SKILL_SRC, skillLink(home));
  const out = runInstall(home);
  assert.equal(fs.readlinkSync(skillLink(home)), SKILL_SRC);
  assert.match(out, /Relinked skill:/);
});

test("a RELATIVE old link into this same repo is resolved against the link's own directory and relinked (M9)", () => {
  const home = mkdtemp();
  const link = skillLink(home);
  const linkDir = path.dirname(link);
  fs.mkdirSync(linkDir, { recursive: true });
  // Relative to the link directory's REALPATH: /tmp is itself a symlink to
  // /private/tmp on macOS, and the OS resolves a relative symlink target
  // against the fully-resolved directory, not the lexical mkdtemp() path.
  const relTarget = path.relative(fs.realpathSync(linkDir), SKILL_SRC);
  fs.symlinkSync(relTarget, link); // a relative target, as some older installs made
  const out = runInstall(home);
  assert.equal(fs.readlinkSync(link), SKILL_SRC);
  assert.match(out, /Relinked skill:/);
});

test("a link into an unrelated repo is left alone and the message says so", () => {
  const home = mkdtemp();
  const otherRepo = mkdtemp();
  execFileSync("git", ["init", "-q", otherRepo]);
  const otherSkill = path.join(otherRepo, "skills", "open-claude-in-chrome");
  fs.mkdirSync(otherSkill, { recursive: true });
  const link = skillLink(home);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(otherSkill, link);
  const out = runInstall(home);
  assert.equal(fs.readlinkSync(link), otherSkill, "an unrelated repo's link must be left untouched");
  assert.match(out, /already points elsewhere/);
});

test("a dangling old link whose target was inside this repo (e.g. a removed worktree) is relinked (M9)", () => {
  const home = mkdtemp();
  const link = skillLink(home);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const goneWorktreeSkill = path.join(MAIN_REPO_ROOT, ".worktrees", "some-removed-lane-that-never-existed", "skills", "open-claude-in-chrome");
  fs.symlinkSync(goneWorktreeSkill, link); // target does not exist on disk
  const out = runInstall(home);
  assert.equal(fs.readlinkSync(link), SKILL_SRC);
  assert.match(out, /Relinked skill:/);
  assert.ok(out.includes(goneWorktreeSkill), "the old (dangling) target should be printed");
});

test("a dangling old link unrelated to this repo is left alone and the message names it as dangling (M9)", () => {
  const home = mkdtemp();
  const link = skillLink(home);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const unrelatedGoneTarget = "/tmp/some-other-repo-that-never-existed-ocic/skills/open-claude-in-chrome";
  fs.symlinkSync(unrelatedGoneTarget, link);
  const out = runInstall(home);
  assert.equal(fs.readlinkSync(link), unrelatedGoneTarget, "an unrelated dangling link must be left untouched");
  assert.match(out, /dangling/);
});

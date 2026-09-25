// Covers install.sh's agent-skill symlink logic only (M9): does it relink,
// leave alone, or warn correctly for every combination of old-link shape
// (absolute/relative, existing/dangling, physical vs. symlink-reached) and
// repo (this one/another one)?
//
// Every test runs install.sh from an ISOLATED TEMP COPY of the files it
// needs (a fresh git repo), never the real checkout under test (N4):
// running it in place would rewrite <checkout>/host/native-host-wrapper.sh,
// which is the file the real browser's native messaging manifest launches
// when this suite runs against the live install's own checkout.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtemp, cleanupTmpDirs } from "./helpers.mjs";

after(cleanupTmpDirs);

const REAL_INSTALL_SH = path.join(import.meta.dirname, "..", "..", "install.sh");
const EXEC_OPTS = { encoding: "utf-8", timeout: 10000 };

// A minimal, isolated stand-in repo: just enough for install.sh's skill-link
// logic to run for real (a real `git init`, so repo_common_dir has a real
// answer), without ever installing npm packages or touching a live checkout.
function makeTempRepo() {
  const root = mkdtemp();
  fs.mkdirSync(path.join(root, "host", "node_modules"), { recursive: true }); // stands in for "already installed", so install.sh never shells out to npm
  fs.writeFileSync(path.join(root, "host", "package.json"), JSON.stringify({ name: "host", private: true }));
  fs.writeFileSync(path.join(root, "host", "native-host.js"), "// stand-in for install.test.mjs\n");
  fs.mkdirSync(path.join(root, "skills", "open-claude-in-chrome"), { recursive: true });
  fs.copyFileSync(REAL_INSTALL_SH, path.join(root, "install.sh"));
  fs.chmodSync(path.join(root, "install.sh"), 0o755);
  execFileSync("git", ["init", "-q", root], { timeout: 10000 });
  return root;
}

function skillSrc(repoRoot) {
  return path.join(repoRoot, "skills", "open-claude-in-chrome");
}

function skillLink(home) {
  return path.join(home, ".claude", "skills", "open-claude-in-chrome");
}

function runInstall(repoRoot, home) {
  fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
  return execFileSync(path.join(repoRoot, "install.sh"), ["faketestextensionid"], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home },
    ...EXEC_OPTS,
  });
}

test("no existing link: creates a fresh symlink to this repo's skill", { timeout: 10000 }, () => {
  const repo = makeTempRepo();
  const home = mkdtemp();
  const out = runInstall(repo, home);
  assert.equal(fs.readlinkSync(skillLink(home)), skillSrc(repo));
  assert.match(out, /Linked skill:/);
});

test("a link already at the exact right target is relinked without complaint", { timeout: 10000 }, () => {
  const repo = makeTempRepo();
  const home = mkdtemp();
  const link = skillLink(home);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(skillSrc(repo), link);
  const out = runInstall(repo, home);
  assert.equal(fs.readlinkSync(link), skillSrc(repo));
  assert.match(out, /Relinked skill:/);
});

// N1: the temp repo (a plain `git init`, not a linked worktree) makes
// `git rev-parse --git-common-dir` return the relative ".git" here, the same
// as it would for the real project's own main checkout — exercising the
// logical-vs-physical-path code path that a linked worktree's absolute
// common-dir answer would otherwise skip entirely. mkdtemp() also already
// places both the repo and HOME under /tmp, itself a symlink to /private/tmp
// on macOS, so this is "the checkout reached through a symlinked path".
test("a RELATIVE old link into this same repo is resolved against the link's own directory and relinked (M9)", { timeout: 10000 }, () => {
  const repo = makeTempRepo();
  const home = mkdtemp();
  const link = skillLink(home);
  const linkDir = path.dirname(link);
  fs.mkdirSync(linkDir, { recursive: true });
  const relTarget = path.relative(fs.realpathSync(linkDir), skillSrc(repo));
  fs.symlinkSync(relTarget, link); // a relative target, as some older installs made
  const out = runInstall(repo, home);
  assert.equal(fs.readlinkSync(link), skillSrc(repo));
  assert.match(out, /Relinked skill:/);
});

test("a link into an unrelated repo is left alone and the message says so", { timeout: 10000 }, () => {
  const repo = makeTempRepo();
  const otherRepo = makeTempRepo();
  const home = mkdtemp();
  const link = skillLink(home);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(skillSrc(otherRepo), link);
  const out = runInstall(repo, home);
  assert.equal(fs.readlinkSync(link), skillSrc(otherRepo), "an unrelated repo's link must be left untouched");
  assert.match(out, /already points elsewhere/);
});

test("a dangling old link whose target was inside this repo (e.g. a removed worktree) is relinked (M9)", { timeout: 10000 }, () => {
  const repo = makeTempRepo();
  const home = mkdtemp();
  const link = skillLink(home);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const goneWorktreeSkill = path.join(fs.realpathSync(repo), ".worktrees", "some-removed-lane-that-never-existed", "skills", "open-claude-in-chrome");
  fs.symlinkSync(goneWorktreeSkill, link); // target does not exist on disk
  const out = runInstall(repo, home);
  assert.equal(fs.readlinkSync(link), skillSrc(repo));
  assert.match(out, /Relinked skill:/);
  assert.ok(out.includes(goneWorktreeSkill), "the old (dangling) target should be printed");
});

// M9 (a): the same removed-worktree scenario, but the old link stored a
// RELATIVE (not absolute) dangling target, as install.sh itself would have
// written before this fix (relative targets only ever point within the repo
// they were linked from).
test("a RELATIVE dangling old link whose target was inside this repo is relinked (M9 a)", { timeout: 10000 }, () => {
  const repo = makeTempRepo();
  const home = mkdtemp();
  const link = skillLink(home);
  const linkDir = path.dirname(link);
  fs.mkdirSync(linkDir, { recursive: true });
  const goneWorktreeSkill = path.join(fs.realpathSync(repo), ".worktrees", "some-removed-lane-that-never-existed", "skills", "open-claude-in-chrome");
  const relTarget = path.relative(fs.realpathSync(linkDir), goneWorktreeSkill); // path.relative works fine on a path that doesn't exist
  fs.symlinkSync(relTarget, link);
  const out = runInstall(repo, home);
  assert.equal(fs.readlinkSync(link), skillSrc(repo));
  assert.match(out, /Relinked skill:/);
});

// M9 (b): a dangling target that escapes the repo through "..", e.g.
// <repo>/../elsewhere/... A lexical (string-prefix) check would wrongly
// treat this as "inside the repo" because the string starts with the
// repo's own path; it must actually resolve outside and be left alone.
test("a dangling old link that escapes the repo through .. is left alone, not relinked (M9 b)", { timeout: 10000 }, () => {
  const repo = makeTempRepo();
  const home = mkdtemp();
  const link = skillLink(home);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const escapingTarget = path.join(fs.realpathSync(repo), "..", "elsewhere-that-never-existed", "skills", "open-claude-in-chrome");
  fs.symlinkSync(escapingTarget, link);
  const out = runInstall(repo, home);
  assert.equal(fs.readlinkSync(link), escapingTarget, "a target that resolves outside the repo must be left untouched");
  assert.match(out, /dangling/);
});

test("a dangling old link unrelated to this repo is left alone and the message names it as dangling (M9)", { timeout: 10000 }, () => {
  const repo = makeTempRepo();
  const home = mkdtemp();
  const link = skillLink(home);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const unrelatedGoneTarget = "/tmp/some-other-repo-that-never-existed-ocic/skills/open-claude-in-chrome";
  fs.symlinkSync(unrelatedGoneTarget, link);
  const out = runInstall(repo, home);
  assert.equal(fs.readlinkSync(link), unrelatedGoneTarget, "an unrelated dangling link must be left untouched");
  assert.match(out, /dangling/);
});

// Covers install.sh's agent-skill symlink logic: does it relink, leave
// alone, or warn correctly for every combination of old-link shape
// (absolute/relative, existing/dangling, physical vs. symlink-reached) and
// repo (this one/another one)? Also covers how the native host wrapper and
// manifest it writes carry a checkout path with unusual characters.
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
// `root` defaults to a fresh temp dir; a test that needs the repo at a fixed
// place inside one of its own temp dirs passes that path.
function makeTempRepo(root = mkdtemp()) {
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

function runInstall(repoRoot, home, extensionIds = ["faketestextensionid"]) {
  fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
  return execFileSync(path.join(repoRoot, "install.sh"), extensionIds, {
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

// The temp repo (a plain `git init`, not a linked worktree) makes
// `git rev-parse --git-common-dir` return a relative path here, the same as
// it would for the real project's own main checkout. A linked worktree's
// absolute common-dir answer would skip the path resolution this covers.
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

// The repo and HOME share one real parent directory, but one of them is
// reached through a symlink to that parent, the way macOS reaches /private/tmp
// through /tmp. The old link's relative target climbs out of the real skills
// dir, so bash's logical `..` handling lands on the repo through the symlinked
// name while this repo's own path is the real one, or the reverse. Comparing
// those two spellings of one repo, a logical-path install.sh sees two
// different repositories and leaves the link alone.
for (const [label, homeViaLink] of [
  ["HOME is reached through a symlink and the repo through its real path", true],
  ["the repo is reached through a symlink and HOME through its real path", false],
]) {
  test(`a RELATIVE old link into this same repo is relinked when ${label}`, { timeout: 10000 }, () => {
    const parent = fs.realpathSync(mkdtemp());
    const alias = path.join(mkdtemp(), "alias");
    fs.symlinkSync(parent, alias);
    makeTempRepo(path.join(parent, "repo"));
    fs.mkdirSync(path.join(parent, "home"));
    const repo = path.join(homeViaLink ? parent : alias, "repo");
    const home = path.join(homeViaLink ? alias : parent, "home");
    const link = skillLink(home);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.relative(path.join(parent, "home", ".claude", "skills"), path.join(parent, "repo", "skills", "open-claude-in-chrome")), link);
    const out = runInstall(repo, home);
    assert.equal(fs.readlinkSync(link), skillSrc(repo));
    assert.match(out, /Relinked skill:/);
  });
}

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
  // Built as a plain string, not with path.join, which would collapse the
  // ".." and leave nothing for a lexical check to get wrong. It starts with
  // the repo path exactly as install.sh is run through (runInstall below),
  // and its sibling folder name is unique to this run, so it never exists.
  const escapingTarget = `${repo}/../${path.basename(repo)}-elsewhere/skills/open-claude-in-chrome`;
  assert.ok(escapingTarget.startsWith(`${repo}/..`), "the target must keep its .. right after the repo path");
  fs.symlinkSync(escapingTarget, link);
  const out = runInstall(repo, home);
  assert.equal(fs.readlinkSync(link), escapingTarget, "a target that resolves outside the repo must be left untouched");
  assert.match(out, /dangling/);
});

// ~/.claude/skills can itself be a symlink, for example into a dotfiles
// checkout. The OS resolves a relative skill link against that real
// directory, so install.sh must too. Here the real skills dir sits one level
// shallower than ~/.claude/skills, so the same "../.." climbs to a different
// place. Read physically, the link points at <base>/repoB, a different repo
// (or nothing, in the dangling test). Read logically, it points at
// ~/repoB, which is this repo. Either way it must be left alone.
function symlinkedSkillsLayout() {
  const base = fs.realpathSync(mkdtemp());
  const home = path.join(base, "home");
  const realSkills = path.join(base, "dotfiles", "skills");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(realSkills, { recursive: true });
  fs.symlinkSync(realSkills, path.join(home, ".claude", "skills"));
  const repo = makeTempRepo(path.join(home, "repoB"));
  return { base, home, repo, link: skillLink(home) };
}

test("a relative link read through a symlinked skills dir into another repo is left alone", { timeout: 10000 }, () => {
  const { base, home, repo, link } = symlinkedSkillsLayout();
  makeTempRepo(path.join(base, "repoB"));
  const target = "../../repoB/skills/open-claude-in-chrome";
  fs.symlinkSync(target, link);
  assert.equal(fs.realpathSync(link), path.join(base, "repoB", "skills", "open-claude-in-chrome"), "the OS must resolve the link into the other repo");
  const out = runInstall(repo, home);
  assert.equal(fs.readlinkSync(link), target, "a link into another repo must be left untouched");
  assert.match(out, /already points elsewhere/);
});

test("a dangling relative link read through a symlinked skills dir that resolves outside this repo is left alone", { timeout: 10000 }, () => {
  const { home, repo, link } = symlinkedSkillsLayout();
  const target = "../../repoB/.worktrees/gone/skills/open-claude-in-chrome";
  fs.symlinkSync(target, link);
  const out = runInstall(repo, home);
  assert.equal(fs.readlinkSync(link), target, "a dangling link outside this repo must be left untouched");
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

// The browser starts the native host through the wrapper install.sh writes,
// which it finds through the manifest's "path". A checkout path holding
// characters that are special in sh or in JSON must reach both as the exact
// same string, and nothing in it may run as a command.
function chromeManifestDir(home) {
  return process.platform === "darwin"
    ? path.join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")
    : path.join(home, ".config", "google-chrome", "NativeMessagingHosts");
}

function manifestFile(home) {
  return path.join(chromeManifestDir(home), "com.anthropic.open_claude_in_chrome.json");
}

for (const [label, dirName] of [
  ["$, backticks and $(...)", "dollar $HOME tick `touch pwned` sub $(touch pwned)"],
  ["\", \\, $, a backtick, $(...) and single quotes", `all " back\\slash $HOME \`touch pwned\` $(touch pwned) 'q'`],
]) {
  test(`a checkout path with ${label} gives a valid wrapper and manifest, and nothing in it runs`, { timeout: 10000 }, () => {
    const repo = makeTempRepo(path.join(mkdtemp(), dirName));
    const home = mkdtemp();
    fs.mkdirSync(path.dirname(chromeManifestDir(home)), { recursive: true }); // install.sh skips a browser whose folder is missing
    const hostJs = path.join(repo, "host", "native-host.js");
    fs.writeFileSync(hostJs, "process.stdout.write(JSON.stringify(process.argv.slice(1)));\n");
    runInstall(repo, home);
    assert.ok(!fs.existsSync(path.join(repo, "pwned")), "install.sh must not run anything from the checkout path");

    const wrapper = path.join(repo, "host", "native-host-wrapper.sh");
    const manifest = JSON.parse(fs.readFileSync(manifestFile(home), "utf-8"));
    assert.equal(manifest.path, wrapper);
    execFileSync("/bin/sh", ["-n", wrapper], EXEC_OPTS);

    const cwd = mkdtemp();
    let out, runError;
    try {
      out = execFileSync(wrapper, [], { cwd, env: { ...process.env, HOME: home }, ...EXEC_OPTS });
    } catch (err) {
      runError = err;
    }
    assert.ok(!fs.existsSync(path.join(cwd, "pwned")), "the wrapper must not run anything from the checkout path");
    assert.ifError(runError);
    assert.deepEqual(JSON.parse(out), [hostJs]);
  });
}

test("the manifest for ordinary extension ids keeps its exact bytes", { timeout: 10000 }, () => {
  const repo = makeTempRepo();
  const home = mkdtemp();
  fs.mkdirSync(path.dirname(chromeManifestDir(home)), { recursive: true });
  runInstall(repo, home, ["aaaabbbbccccddddeeeeffffgggghhhh", "ppppoooonnnnmmmmllllkkkkjjjjiiii"]);
  const wrapper = path.join(repo, "host", "native-host-wrapper.sh");
  assert.equal(fs.readFileSync(manifestFile(home), "utf-8"), [
    "{",
    '  "name": "com.anthropic.open_claude_in_chrome",',
    '  "description": "Open Claude in Chrome Native Messaging Host",',
    `  "path": "${wrapper}",`,
    '  "type": "stdio",',
    '  "allowed_origins": [',
    '    "chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh/",',
    '    "chrome-extension://ppppoooonnnnmmmmllllkkkkjjjjiiii/"',
    "  ]",
    "}",
    "",
  ].join("\n"));
});

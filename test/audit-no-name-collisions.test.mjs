// Fix round 3, item 5: redact.js, store.js and audit.js are classic scripts
// loaded by background.js via importScripts, so every top-level declaration in
// any of them shares ONE global scope with background.js itself. A name
// declared in two of those files silently collides — whichever importScripts
// loads last (or, for background.js's own declarations, whichever the engine
// hoists last) wins, and the other is gone with no error. This bit exactly
// once already: redact.js's own `normalizeNavigateUrl` replaced a like-named
// function Task 12 added to background.js on the integration branch, breaking
// navigate there (invisible in this worktree, since Task 12's code isn't here).
//
// This is a static, source-level check — not a runtime one — so it catches a
// collision that would only ever show up after a merge this worktree can't see.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const EXT = path.join(import.meta.dirname, "..", "extension");

// Only column-0 (unindented) declarations count: store.js and audit.js wrap
// their internals in an IIFE (see their own comments/tests for why), so their
// own helpers are indented and never reach the shared global scope at all —
// counting them here would be a false positive, not a real collision risk.
function topLevelNames(source) {
  const names = new Set();
  const patterns = [
    /^(?:async\s+)?function\s+(\w+)/gm,
    /^class\s+(\w+)/gm,
    /^const\s+(\w+)/gm,
    /^let\s+(\w+)/gm,
    /^var\s+(\w+)/gm,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) !== null) names.add(m[1]);
  }
  return names;
}

test("no top-level name collides between background.js and every file it importScripts", () => {
  const bgSource = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  const importMatch = bgSource.match(/importScripts\(([^)]*)\)/);
  assert.ok(importMatch, "expected an importScripts(...) call in background.js");
  const importedFiles = [...importMatch[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
  assert.ok(importedFiles.length > 0, "expected importScripts to list at least one file");

  const allFiles = ["background.js", ...importedFiles];
  const namesByFile = new Map(allFiles.map((f) => [f, topLevelNames(fs.readFileSync(path.join(EXT, f), "utf8"))]));

  const declaredIn = new Map(); // name -> the first file it was seen in
  const collisions = [];
  for (const [file, names] of namesByFile) {
    for (const name of names) {
      if (declaredIn.has(name)) collisions.push(`"${name}" is declared at the top level of both ${declaredIn.get(name)} and ${file}`);
      else declaredIn.set(name, file);
    }
  }
  assert.deepEqual(collisions, []);
});

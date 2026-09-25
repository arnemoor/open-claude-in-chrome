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

const IDENTIFIER = /[A-Za-z_$][\w$]*/y;
const WORD = /[\w$]+/y;
const REGEX_AFTER_WORD = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

function skipBlank(src, i) {
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src.startsWith("//", i)) {
      while (i < src.length && !"\n\r\u2028\u2029".includes(src[i])) i++;
    } else if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
    } else {
      return i;
    }
  }
}

function quotedEnd(src, i) {
  const quote = src[i];
  for (i++; i < src.length && src[i] !== quote; i++) if (src[i] === "\\") i++;
  return i + 1;
}

function templateEnd(src, i) {
  for (i++; i < src.length && src[i] !== "`"; i++) {
    if (src[i] === "\\") i++;
    else if (src.startsWith("${", i)) i = scanTo(src, i + 2, "}");
  }
  return i + 1;
}

function regexEnd(src, i) {
  let inClass = false;
  for (i++; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === "[") inClass = true;
    else if (src[i] === "]") inClass = false;
    else if (src[i] === "/" && !inClass) break;
  }
  for (i++; i < src.length && /[a-z]/i.test(src[i]); ) i++;
  return i;
}

// The index of the first character in `stops` at bracket depth 0, scanning
// code from `i` and skipping strings, templates, comments and regex literals
// whole, so a comma or a bracket inside one never counts. These are our own
// sources, so the token before a "/" is enough to tell a regex from a division.
function scanTo(src, i, stops) {
  let depth = 0;
  let regexAllowed = true;
  for (;;) {
    i = skipBlank(src, i);
    const ch = src[i];
    if (i >= src.length || (depth === 0 && stops.includes(ch))) return i;
    if (ch === "'" || ch === '"') {
      i = quotedEnd(src, i);
      regexAllowed = false;
    } else if (ch === "`") {
      i = templateEnd(src, i);
      regexAllowed = false;
    } else if (ch === "/" && regexAllowed) {
      i = regexEnd(src, i);
      regexAllowed = false;
    } else if (/[\w$]/.test(ch)) {
      WORD.lastIndex = i;
      WORD.test(src);
      regexAllowed = REGEX_AFTER_WORD.has(src.slice(i, WORD.lastIndex));
      i = WORD.lastIndex;
    } else {
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch) && --depth < 0) return i;
      regexAllowed = ch !== ")" && ch !== "]";
      i++;
    }
  }
}

// Every declarator of the const/let/var statement whose first binding starts
// at `i`: the statement is split at its depth-0 commas until its ";".
function declaratorNames(src, i) {
  const names = [];
  for (;;) {
    i = skipBlank(src, i);
    IDENTIFIER.lastIndex = i;
    const m = IDENTIFIER.exec(src);
    if (!m) throw new Error(`cannot read the declaration at offset ${i}, a destructuring pattern? ${JSON.stringify(src.slice(i, i + 40))}`);
    names.push(m[0]);
    i = scanTo(src, i + m[0].length, ",;");
    if (src[i] !== ",") return names;
    i++;
  }
}

// Only column-0 (unindented) declarations count: store.js and audit.js wrap
// their internals in an IIFE (see their own comments/tests for why), so their
// own helpers are indented and never reach the shared global scope at all —
// counting them here would be a false positive, not a real collision risk.
const DECLARATION = /^(?:(?:async\s+)?function\b\s*\*?\s*([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\b)/gm;

function topLevelNames(src) {
  const names = new Set();
  for (const m of src.matchAll(DECLARATION)) {
    const declared = m[1] || m[2] ? [m[1] || m[2]] : declaratorNames(src, m.index + m[0].length);
    for (const name of declared) names.add(name);
  }
  return names;
}

function importedFiles(src) {
  return [...src.matchAll(/importScripts\(([^)]*)\)/g)].flatMap((call) => [...call[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]));
}

// background.js and every file an importScripts call loads into its global
// scope, from background.js or from a file it loads.
function nameCollisions(read) {
  const files = ["background.js"];
  for (let k = 0; k < files.length; k++) {
    for (const file of importedFiles(read(files[k]))) if (!files.includes(file)) files.push(file);
  }
  assert.ok(files.length > 1, "expected background.js to importScripts at least one file");

  const declaredIn = new Map(); // name -> the first file it was seen in
  const collisions = [];
  for (const file of files) {
    for (const name of topLevelNames(read(file))) {
      if (declaredIn.has(name)) collisions.push(`"${name}" is declared at the top level of both ${declaredIn.get(name)} and ${file}`);
      else declaredIn.set(name, file);
    }
  }
  return collisions;
}

test("no top-level name collides between background.js and every file it importScripts", () => {
  assert.deepEqual(nameCollisions((f) => fs.readFileSync(path.join(EXT, f), "utf8")), []);
});

// Fix round 4, item 5: the round 3 check read only the first name of a
// statement like background.js's `const MOD_ALT = 1, MOD_CTRL = 2, ...` and
// only the first importScripts call.
test("the check sees a name declared only as a later declarator of a statement", () => {
  const sources = {
    "background.js": 'importScripts("extra.js");\nconst MOD_ALT = 1, MOD_CTRL = 2, MOD_META = 4;\n',
    "extra.js": 'const RE = /[",]/g, LABELS = { a: "x, y", b: [1, 2] }, MOD_CTRL = f(1, 2);\n',
  };
  assert.deepEqual(nameCollisions((f) => sources[f]), ['"MOD_CTRL" is declared at the top level of both background.js and extra.js']);
});

test("the check reads the files of every importScripts call, not only the first", () => {
  const sources = {
    "background.js": 'importScripts("a.js");\nimportScripts("b.js");\nfunction shared() {}\n',
    "a.js": "const A = 1;\n",
    "b.js": "function shared() {}\n",
  };
  assert.deepEqual(nameCollisions((f) => sources[f]), ['"shared" is declared at the top level of both background.js and b.js']);
});

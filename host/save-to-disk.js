// Writes images the browser extension tagged with `saveToDisk` to disk on
// the host, replacing the tag with a text block reporting the saved path (or
// the failure) right after the image. The extension no longer needs the
// chrome.downloads permission or its unstable path.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function screenshotsDir(home = os.homedir()) {
  return path.join(home, "Downloads", "open-claude-in-chrome");
}

function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}

// Local-time timestamp: YYYYMMDD-HHMMSS-mmm.
function timestamp(date) {
  const ymd = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const hms = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${ymd}-${hms}-${pad(date.getMilliseconds(), 3)}`;
}

function sanitizePrefix(prefix) {
  return /^[a-z]+$/.test(prefix) ? prefix : "screenshot";
}

// Opens "<dir>/<base>.jpg" exclusively, retrying with -1, -2, ... suffixes on
// EEXIST so two images saved in the same millisecond never collide.
function openUnique(dir, base) {
  for (let n = 0; ; n += 1) {
    const suffix = n === 0 ? "" : `-${n}`;
    const file = path.join(dir, `${base}${suffix}.jpg`);
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      return { fd, file };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
  }
}

// Creates the screenshots folder (mode 0700) if missing, and refuses to use
// it unless it is a real directory owned by the current user: `~/Downloads`
// is writable by anything that can drop entries there (an extracted archive,
// a sync client), and following a symlink planted there would write sensitive
// screenshots into, and chmod, a folder the user never chose for this. Once
// the check passes, the chmod also runs on an already-existing folder,
// deliberately tightening one an older version left at the umask default.
function ensureScreenshotsDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`refusing to use ${dir}: it is not a real directory (symlink?)`);
  if (st.uid !== process.getuid()) throw new Error(`refusing to use ${dir}: it is not owned by the current user`);
  fs.chmodSync(dir, 0o700);
}

function save(block, prefix, dir, now) {
  // Decode before touching the filesystem: bad image data then fails before
  // any directory or file is created, so there is nothing to clean up.
  const buf = Buffer.from(block.data, "base64");
  ensureScreenshotsDir(dir);
  const base = `${prefix}_${timestamp(now())}`;
  const { fd, file } = openUnique(dir, base);
  try {
    // writeFileSync loops until every byte is written and throws on error,
    // unlike a single writeSync call, which can silently return a short
    // count when the write is truncated (e.g. EFBIG, ENOSPC).
    fs.writeFileSync(fd, buf);
  } catch (err) {
    fs.closeSync(fd);
    try { fs.unlinkSync(file); } catch { /* best effort: report the write error, not this one */ }
    throw err;
  }
  fs.closeSync(fd);
  return file;
}

// Mutates and returns `result`: writes every image block carrying a string
// `saveToDisk` marker to disk, removes the marker, and inserts a text block
// right after the image reporting the saved path or the failure. Blocks
// without the marker (and non-object entries) are untouched. Never throws.
export function applySaveToDisk(result, { home = os.homedir(), now = () => new Date() } = {}) {
  const dir = screenshotsDir(home);
  const content = result.content;
  // Forward, so images at the same timestamp collide in content order (the
  // first gets the bare name, the next -1, and so on); step past each
  // inserted note so it isn't visited as a new block.
  for (let i = 0; i < content.length; i += 1) {
    const block = content[i];
    if (!block || block.type !== "image" || typeof block.saveToDisk !== "string") continue;

    // Read the marker before deleting it: sanitizePrefix needs the original value.
    const prefix = sanitizePrefix(block.saveToDisk);
    delete block.saveToDisk;
    let note;
    try {
      const file = save(block, prefix, dir, now);
      note = { type: "text", text: `Saved to disk: ${file}` };
    } catch (err) {
      note = { type: "text", text: `save_to_disk failed: ${err.message}` };
    }
    content.splice(i + 1, 0, note);
    i += 1;
  }
  return result;
}

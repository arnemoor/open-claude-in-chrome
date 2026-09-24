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

function save(block, prefix, dir, now) {
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o700);
  const base = `${prefix}_${timestamp(now())}`;
  const { fd, file } = openUnique(dir, base);
  try {
    fs.writeSync(fd, Buffer.from(block.data, "base64"));
  } finally {
    fs.closeSync(fd);
  }
  return file;
}

// Mutates and returns `result`: writes every image block carrying a string
// `saveToDisk` marker to disk, removes the marker, and inserts a text block
// right after the image reporting the saved path or the failure. Blocks
// without the marker are untouched. Never throws.
export function applySaveToDisk(result, { home = os.homedir(), now = () => new Date() } = {}) {
  const dir = screenshotsDir(home);
  const content = result.content;
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const block = content[i];
    if (block.type !== "image" || typeof block.saveToDisk !== "string") continue;

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
  }
  return result;
}

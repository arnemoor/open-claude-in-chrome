import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applySaveToDisk, screenshotsDir } from "../save-to-disk.js";

const b64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
const now = () => new Date(2026, 8, 24, 14, 5, 6, 7);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

test("writes marked images with private permissions and reports the path", () => {
  const home = fs.mkdtempSync("/tmp/ocic-");
  const r = applySaveToDisk({ content: [{ type: "text", text: "shot" }, { type: "image", data: b64, mimeType: "image/jpeg", saveToDisk: "screenshot" }] }, { home, now });
  const file = path.join(screenshotsDir(home), "screenshot_20260924-140506-007.jpg");
  assert.deepEqual(fs.readFileSync(file), Buffer.from(b64, "base64"));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(screenshotsDir(home)).mode & 0o777, 0o700);
  assert.equal(r.content[1].saveToDisk, undefined);
  assert.deepEqual(r.content[2], { type: "text", text: `Saved to disk: ${file}` });
});

test("unmarked images are untouched", () => {
  const home = fs.mkdtempSync("/tmp/ocic-");
  const r = applySaveToDisk({ content: [{ type: "image", data: b64, mimeType: "image/jpeg" }] }, { home, now });
  assert.equal(r.content.length, 1);
  assert.ok(!fs.existsSync(screenshotsDir(home)));
});

test("two marked images in one result get distinct files; bad prefixes are sanitised", () => {
  const home = fs.mkdtempSync("/tmp/ocic-");
  const r = applySaveToDisk({ content: [
    { type: "image", data: b64, mimeType: "image/jpeg", saveToDisk: "zoom" },
    { type: "image", data: b64, mimeType: "image/jpeg", saveToDisk: "../evil" },
  ] }, { home, now });
  const texts = r.content.filter((b) => b.type === "text").map((b) => b.text);
  assert.equal(texts.length, 2);
  assert.match(texts[0], /zoom_20260924-140506-007\.jpg$/);
  assert.match(texts[1], /screenshot_20260924-140506-007\.jpg$/);
});

test("three same-prefix images collide in content order: bare, -1, -2", () => {
  const home = fs.mkdtempSync("/tmp/ocic-");
  const r = applySaveToDisk({ content: [
    { type: "image", data: b64, mimeType: "image/jpeg", saveToDisk: "screenshot" },
    { type: "image", data: b64, mimeType: "image/jpeg", saveToDisk: "screenshot" },
    { type: "image", data: b64, mimeType: "image/jpeg", saveToDisk: "screenshot" },
  ] }, { home, now });
  const texts = r.content.filter((b) => b.type === "text").map((b) => b.text);
  assert.equal(texts.length, 3);
  assert.match(texts[0], /screenshot_20260924-140506-007\.jpg$/);
  assert.match(texts[1], /screenshot_20260924-140506-007-1\.jpg$/);
  assert.match(texts[2], /screenshot_20260924-140506-007-2\.jpg$/);
});

test("a write failure is reported, never thrown, and the marker never leaks", () => {
  const home = fs.mkdtempSync("/tmp/ocic-");
  fs.mkdirSync(path.join(home, "Downloads"));
  fs.writeFileSync(screenshotsDir(home), "a file where the folder should be");
  const r = applySaveToDisk({ content: [{ type: "image", data: b64, mimeType: "image/jpeg", saveToDisk: "screenshot" }] }, { home, now });
  assert.match(r.content[1].text, /^save_to_disk failed: /);
  assert.equal("saveToDisk" in r.content[0], false);
});

test("a symlink at the screenshots folder is refused, and its target is left untouched", () => {
  const home = fs.mkdtempSync("/tmp/ocic-");
  const target = fs.mkdtempSync("/tmp/ocic-target-");
  fs.chmodSync(target, 0o755);
  fs.mkdirSync(path.join(home, "Downloads"));
  fs.symlinkSync(target, screenshotsDir(home));
  const before = fs.readdirSync(target);
  const r = applySaveToDisk({ content: [{ type: "image", data: b64, mimeType: "image/jpeg", saveToDisk: "screenshot" }] }, { home, now });
  assert.match(r.content[1].text, /^save_to_disk failed: /);
  assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(target), before);
});

test("non-object content entries are skipped without throwing", () => {
  const home = fs.mkdtempSync("/tmp/ocic-");
  const r = applySaveToDisk({ content: [null, { type: "image", data: b64, mimeType: "image/jpeg", saveToDisk: "screenshot" }] }, { home, now });
  assert.equal(r.content[0], null);
  assert.match(r.content[2].text, /^Saved to disk: /);
});

test("a write that fails partway through is reported as a failure, and no file is left behind", () => {
  const home = fs.mkdtempSync("/tmp/ocic-");
  const modulePath = pathToFileURL(path.join(moduleDir, "..", "save-to-disk.js")).href;
  const bigB64 = Buffer.alloc(20000, 0xaa).toString("base64");
  const scriptPath = path.join(home, "run.mjs");
  fs.writeFileSync(scriptPath, `
    import { applySaveToDisk } from ${JSON.stringify(modulePath)};
    const r = applySaveToDisk(
      { content: [{ type: "image", data: ${JSON.stringify(bigB64)}, mimeType: "image/jpeg", saveToDisk: "screenshot" }] },
      { home: ${JSON.stringify(home)} }
    );
    process.stdout.write(JSON.stringify(r));
  `);
  // ulimit -f pins the child's max file size well below the 20000-byte image,
  // so the write fails partway through (a stand-in for a full disk).
  const out = execFileSync("/bin/sh", ["-c", `ulimit -f 4 && exec node "${scriptPath}"`], { encoding: "utf8", timeout: 5000 });
  const r = JSON.parse(out);
  assert.match(r.content[1].text, /^save_to_disk failed: /);
  assert.deepEqual(fs.readdirSync(screenshotsDir(home)), []);
});

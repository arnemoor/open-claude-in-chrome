import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applySaveToDisk, screenshotsDir } from "../save-to-disk.js";

const b64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
const now = () => new Date(2026, 8, 24, 14, 5, 6, 7);

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

test("a write failure is reported, never thrown", () => {
  const home = fs.mkdtempSync("/tmp/ocic-");
  fs.mkdirSync(path.join(home, "Downloads"));
  fs.writeFileSync(screenshotsDir(home), "a file where the folder should be");
  const r = applySaveToDisk({ content: [{ type: "image", data: b64, mimeType: "image/jpeg", saveToDisk: "screenshot" }] }, { home, now });
  assert.match(r.content[1].text, /^save_to_disk failed: /);
});

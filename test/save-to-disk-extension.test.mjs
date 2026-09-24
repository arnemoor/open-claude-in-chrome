import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadBackground } from "./harness/fake-chrome.mjs";

test("screenshot and zoom mark the image for the host to save", async () => {
  const bg = await loadBackground({ overrides: { downloads: { download: async () => { throw new Error("must not be called"); } } } });
  const shot = await bg.handlers.computer({ action: "screenshot", save_to_disk: true, tabId: bg.tabId });
  assert.equal(shot.content[1].saveToDisk, "screenshot");
  assert.doesNotMatch(shot.content[0].text, /disk/i);
  const zoom = await bg.handlers.computer({ action: "zoom", region: [0, 0, 10, 10], save_to_disk: true, tabId: bg.tabId });
  assert.equal(zoom.content[1].saveToDisk, "zoom");
  const plain = await bg.handlers.computer({ action: "screenshot", tabId: bg.tabId });
  assert.equal(plain.content[1].saveToDisk, undefined);
});

test("the extension no longer needs the downloads permission", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "extension", "manifest.json"), "utf8"));
  assert.ok(!manifest.permissions.includes("downloads"));
  assert.doesNotMatch(fs.readFileSync(path.join(import.meta.dirname, "..", "extension", "background.js"), "utf8"), /chrome\.downloads/);
});

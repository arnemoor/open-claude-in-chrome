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

// Minor 7: the host schema validates save_to_disk only on a top-level call, not one nested
// inside browser_batch, so a truthy non-boolean like the string "false" reached this compare.
test('save_to_disk: "false" (a truthy string) does not save the image', async () => {
  const bg = await loadBackground();
  const shot = await bg.handlers.computer({ action: "screenshot", save_to_disk: "false", tabId: bg.tabId });
  assert.equal(shot.content[1].saveToDisk, undefined);
  const zoom = await bg.handlers.computer({ action: "zoom", region: [0, 0, 10, 10], save_to_disk: "false", tabId: bg.tabId });
  assert.equal(zoom.content[1].saveToDisk, undefined);
});

// Minor 13 test gap: only a plain screenshot was checked for "no marker, no disk mention" — zoom
// never was.
test("a plain zoom has no save marker and no mention of disk", async () => {
  const bg = await loadBackground();
  const zoom = await bg.handlers.computer({ action: "zoom", region: [0, 0, 10, 10], tabId: bg.tabId });
  assert.equal(zoom.content[1].saveToDisk, undefined);
  assert.doesNotMatch(zoom.content[0].text, /disk/i);
});

// Minor 13 test gap: the host relies on browser_batch flattening a nested action's content
// (including the saveToDisk-tagged image block) into the top-level reply; nothing pinned that.
test("a save_to_disk screenshot nested inside browser_batch still reaches the top-level content", async () => {
  const bg = await loadBackground();
  const r = await bg.handlers.browser_batch({ actions: [{ name: "computer", input: { action: "screenshot", save_to_disk: true, tabId: bg.tabId } }] });
  const image = r.content.find((b) => b.type === "image");
  assert.equal(image?.saveToDisk, "screenshot");
});

test("the extension no longer needs the downloads permission", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "extension", "manifest.json"), "utf8"));
  assert.ok(!manifest.permissions.includes("downloads"));
  assert.doesNotMatch(fs.readFileSync(path.join(import.meta.dirname, "..", "extension", "background.js"), "utf8"), /chrome\.downloads/);
});

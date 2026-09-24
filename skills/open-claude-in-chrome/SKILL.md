---
name: open-claude-in-chrome
description: Use before calling any mcp__open-claude-in-chrome__* tool (computer, navigate, file_upload, find, browser_batch, and the rest of this fork's 22-tool browser automation surface). Also use when a call is refused, returns a LOST error, or behaves unexpectedly.
---

# Open Claude in Chrome

Tool-usage notes for this fork's browser automation MCP server (`mcp__open-claude-in-chrome__*`, 22 tools, no domain blocklist). Covers mechanics the tool descriptions don't spell out: what gets rejected, where files land, and what a reply is telling you.

## Files: upload and save

- `file_upload` accepts only paths under `~/Downloads` or `~/Desktop`, or a directory listed in `fileUploadAllowedDirs` (`~/.config/open-claude-in-chrome/config.json`) if the user configured one. If a file you generated lives elsewhere, save it to `~/Downloads` first, then upload it. The same check applies to a `file_upload` action nested inside `browser_batch`.
- Combined size per call: under 10 MB.
- A broken or invalid allowlist config fails closed: every upload is refused, and the error names the fix. Do not retry the same path hoping it was a fluke.
- There is no separate "save_to_disk" tool. It is `computer`'s `screenshot` and `zoom` actions with `save_to_disk: true`. The image is written to `~/Downloads/open-claude-in-chrome/` (files mode 0600), and the reply gives the exact saved path.

## Clicking and typing

- A click reply names what it hit, for example `Clicked at (120, 40) on button#submit "Sign in".` A note like `Warning: The click point is covered by ...` means something else sits on top of your target. Take a screenshot before retrying.
- A coordinate outside the current viewport is refused ("Scroll first or use a ref"). Clicking **by ref** (from `read_page` or `find`) scrolls it into view instead of refusing, and the reply says so. Take a fresh screenshot before reusing any coordinate you read before that scroll.
- `type` sends real per-character key events, including umlauts, emoji and CJK text. A literal line break (`\n`) becomes a real line break only in a multi-line field (`textarea` or contenteditable). In a single-line input it is dropped, and the reply says so. Use `key` with `text: "Enter"` to submit a single-line form. Some shifted punctuation cannot be built as a `key` combo (`shift+1` does not produce `"!"`), so `type` that character directly instead.
- A reply that says the browser connection was lost ("LOST") means the action may or may not have completed. Check the page state, for example with a screenshot, before deciding whether to retry. Never blindly repeat a click or a `type`.

## navigate

A bare domain gets `https://` added. Explicit schemes (`http`, `file`, `data`, `about`, `chrome`, and others) are kept as given. `file://` URLs need "Allow access to file URLs" enabled for this extension in `chrome://extensions`, and the reply explains this when it is off. `javascript:` URLs are refused (use `javascript_tool` instead), and so is navigating to this extension's own pages.

## Audit mode

The browser profile may have its own opt-in audit log: a redacted action summary plus a masked screen replay, for the user's own oversight. It is switched on only from the extension's options page. No MCP tool can read or change it, and it never changes a tool's result. Typed text and form values are always redacted in that log.

## Honest stubs

`gif_creator`, `shortcuts_list`, `shortcuts_execute`, `switch_browser`, `list_connected_browsers` and `select_browser` all reply that the feature is not supported. They never silently no-op. Do not retry them expecting a different result.

## Safari

This server drives Chromium browsers only. For Safari, use the separate `safari-mcp` server: isolated, logged-out windows, not the user's real session.

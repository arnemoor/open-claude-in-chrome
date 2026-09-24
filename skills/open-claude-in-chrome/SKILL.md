---
name: open-claude-in-chrome
description: Use before calling any mcp__open-claude-in-chrome__* tool (computer, navigate, file_upload, find, browser_batch, and the rest of this fork's 22-tool browser automation surface). Also use when a call is refused, says the browser connection was lost, or behaves unexpectedly.
---

# Open Claude in Chrome

Tool-usage notes for this fork's browser automation MCP server (`mcp__open-claude-in-chrome__*`, 22 tools, no domain blocklist): what gets rejected, where files land, and what a reply means.

## Files: upload and save

- `file_upload` accepts only paths under `~/Downloads` and `~/Desktop` by default. If the user set `fileUploadAllowedDirs` (`~/.config/open-claude-in-chrome/config.json`), that list *replaces* the defaults, and the refusal names exactly what's allowed now. Save generated files into an allowed folder first. Never edit `config.json` yourself. Ask the user to add a folder. The same check applies to a `file_upload` action nested inside `browser_batch`, per action (two 8 MB uploads in one batch both pass).
- Combined size limit: 10 MB per `file_upload` action.
- A broken or invalid allowlist config fails closed: every upload is refused. Do not retry the same path hoping it was a fluke.
- No separate "save_to_disk" tool exists. It's `computer`'s `screenshot`/`zoom` with `save_to_disk: true`, written to `~/Downloads/open-claude-in-chrome/`. The reply gives the exact path.
- macOS privacy protection covers `~/Downloads` and `~/Desktop`. An `EPERM` in a `save_to_disk`/`file_upload` reply means the running app lacks that permission, not a bad path. Tell the user, don't retry or copy the file elsewhere.

## Clicking and typing

- A click reply names what it hit, e.g. `Clicked at (120, 40) on button#submit "Sign in".` Compare that against your target. Only a **ref** click (`ref` from `read_page`/`find`) also warns `Warning: The click point is covered by ...`. A coordinate click gets no such warning, only the "on ..." name.
- A coordinate outside the viewport is refused ("Scroll first or use a ref"). A ref click scrolls into view instead and says so. Take a fresh screenshot before reusing a coordinate read before that scroll.
- `type` presses real keys only for US-keyboard characters (letters, digits, common punctuation). Everything else (umlauts, ß, emoji, CJK) is inserted as text with no key events, one character at a time, landing exactly either way. A literal line break is real only in a multi-line field. A single-line field drops it, and the reply says so. Use `key` with `text: "Enter"` to submit. `shift+1` presses Shift and 1, not `!`. Type punctuation directly instead.
- A reply saying the browser connection was lost, or that the request timed out, means the action may or may not have completed. Check the page state first. Never blindly repeat a click or a `type`.

## navigate

Kept exactly as given: `http`, `https`, `file`, `data`, `about`, `chrome`, `brave`, `edge`, `view-source`, `blob`, `ftp`, and `chrome-extension:` for another extension's id. A bare host gets `https://` added. Anything else unlisted can get mangled into an odd URL instead of refused, so don't rely on it surviving as written. `file://` needs "Allow access to file URLs" enabled in `chrome://extensions`. `javascript:` and this extension's own pages are refused.

## Audit mode

The browser profile may have its own opt-in audit log and DOM replay (rrweb), switched on only from the extension's options page. No MCP tool can read or change it, and it never changes a tool's result. `type`/`form_input` string values and runs of plain `key` presses are kept only as a count, never the value (named keys like `Enter`/`ctrl+a` are kept as given). Stored URLs, including inside error text, have their query and fragment removed. `javascript_tool` code (up to 500 characters) is kept, but string literals inside it become `[N chars]`. `find` queries and file paths are kept as given, so enter secrets with `type`/`form_input` into a real field, never through `javascript_tool`. The replay masks every input, textarea, select, password and contenteditable value on screen.

## Honest stubs

`gif_creator`, `shortcuts_list`, `shortcuts_execute`, `switch_browser`, `list_connected_browsers` and `select_browser` all reply "not supported." Don't retry expecting a different result.

## Safari

This server drives Chromium only. For Safari, use the separate `safari-mcp` server: isolated, logged-out windows, not the user's real session.

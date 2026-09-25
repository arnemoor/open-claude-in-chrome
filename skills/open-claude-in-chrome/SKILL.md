---
name: open-claude-in-chrome
description: Use before calling any mcp__open-claude-in-chrome__* tool (computer, navigate, file_upload, find, browser_batch, and the rest of this fork's 22-tool browser automation surface). Also use when a call is refused, says the browser connection was lost, or behaves unexpectedly.
---

# Open Claude in Chrome

Tool-usage notes for this fork's browser automation MCP server (`mcp__open-claude-in-chrome__*`, 22 tools, no domain blocklist): what gets rejected, where files land, and what a reply means.

## Files: upload and save

- `file_upload` accepts only paths under `~/Downloads` and `~/Desktop` by default. If the user set `fileUploadAllowedDirs` (`~/.config/open-claude-in-chrome/config.json`), that list *replaces* the defaults, and the refusal names exactly what's allowed now. Save generated files into an allowed folder first. Never edit `config.json` yourself. Ask the user to add a folder. The same check applies to a `file_upload` action nested inside `browser_batch`, per action (two 8 MB uploads in one batch both pass).
- Combined size limit: 10 MB per `file_upload` action.
- A broken or invalid allowlist config fails closed: every upload is refused, and the error names the fix. Do not retry the same path hoping it was a fluke.
- No separate "save_to_disk" tool exists. It's `computer`'s `screenshot`/`zoom` with `save_to_disk: true`, written to `~/Downloads/open-claude-in-chrome/` (files mode 0600). The reply gives the exact path.
- macOS privacy protection covers `~/Downloads` and `~/Desktop`. An `EPERM` in a `save_to_disk`/`file_upload` reply means the running app, or for `file_upload` the browser itself, lacks that permission, not a bad path. Tell the user, don't retry or copy the file elsewhere.

## Clicking and typing

- A click reply names what it hit, e.g. `Clicked at (120, 40) on button#submit "Sign in".` Compare that against your target. Only a **ref** click (`ref` from `read_page`/`find`) also warns `Warning: The click point is covered by ...`. A coordinate click never gets that warning, but it can still carry a label note (a disabled or unassociated control), so check the "on ..." name and any note.
- A coordinate outside the viewport is refused ("Scroll first or use a ref"). A ref click scrolls into view instead and says so. Take a fresh screenshot before reusing a coordinate read before that scroll.
- `type` presses real keys only for US-keyboard characters (letters, digits, common punctuation). Everything else (umlauts, ß, emoji, CJK) is inserted as text with no key events, one character at a time, landing exactly either way. A literal line break is real only in a multi-line field. A single-line field drops it, and the reply says so. Use `key` with `text: "Enter"` to submit. `shift+1` presses Shift and 1, not `!`. Type punctuation directly instead.
- A reply saying the browser connection was lost, or that the request timed out, means the action may or may not have completed. Wait a few seconds before checking the page state (longer after a `browser_batch`). The action can still be finishing in the browser even though the reply already came back. Never blindly repeat a click or a `type`.
- A reply saying the browser extension is not connected, or refusing to connect (optionally naming a security problem), means the request never reached the browser at all. Unlike after a lost connection, nothing ran. It's safe to tell the user to start the browser (or fix whatever the message names) and then retry the same call.

## navigate

Kept exactly as given: `http`, `https`, `data`, `about`, `chrome`, `brave`, `edge`, `view-source`, `blob`, `ftp`, and `chrome-extension:` for another extension's id. A bare host gets `https://` added. Anything else unlisted can get mangled into an odd URL instead of refused (`webcal://h` becomes `https://webcal://h`), so don't rely on it surviving as written. `javascript:` and this extension's own pages are refused, even wrapped in `view-source:`/`blob:`, though that unwrapping is only for the extension's own pages: `view-source:javascript:...` itself still gets through.

`file:` URLs are blocked by design, also wrapped in `view-source:`/`blob:`: `navigate` replies `file: URLs are blocked: the agent cannot open local files.` This isn't a permission you can enable. Chrome grants unpacked extensions file access by default, and a page read would bypass the `file_upload` allowlist entirely, so it stays blocked even with "Allow access to file URLs" on in `chrome://extensions` (the user can still turn that switch off there for defense in depth). Every tool also refuses a tab that's already showing a `file://` page or one of this extension's own pages: `Tab <id> shows a local file or this extension's own page, which the agent cannot use.` Don't ask the user to enable file access to work around either refusal. No setting changes it.

## Audit mode

The browser profile may have its own opt-in audit log and DOM replay (rrweb), switched on only from the extension's options page. No MCP tool can read or change it. An audit failure never changes a tool's result, though the first audited call on a given page can wait up to about 2 seconds for that page's recorder to start. `type` text and `form_input` values are kept only as a count, never the value, but a boolean form value is kept as `checked=true`/`checked=false`. A run of plain `key` presses is kept only as a count too (named keys like `Enter`/`ctrl+a` are kept as given). Stored URLs, including inside error text, have their query and fragment removed everywhere. `javascript_tool` code (up to 500 characters) is kept, but string literals inside it become `[N chars]`. `find` queries and file paths are kept as given, so enter secrets with `type`/`form_input` into a real field, never through `javascript_tool`. The replay masks every input, textarea, select, password and contenteditable value to asterisks of the same length, but ordinary page text is recorded as is.

## Honest stubs

`gif_creator`, `shortcuts_list`, `shortcuts_execute`, `switch_browser`, `list_connected_browsers` and `select_browser` are honest stubs, each explaining what's missing in its own words (for example `shortcuts_execute` replies "Shortcuts are not supported in this extension."). Don't retry expecting a different result.

## Safari

This server drives Chromium only. For Safari, use the separate `safari-mcp` server: isolated, logged-out windows, not the user's real session.

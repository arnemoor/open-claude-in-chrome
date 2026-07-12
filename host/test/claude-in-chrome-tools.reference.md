# claude-in-chrome — Tool Reference

Live schemas of the `mcp__claude-in-chrome__*` browser-automation tools, as exposed
to Claude Code on 2026-07-12. These are injected by the built-in Chrome-extension
bridge, not a configured `.mcp.json` MCP server, so `claude mcp get claude-in-chrome`
does not work. See "How to regenerate" at the bottom.

22 tools total.

---

## browser_batch

Execute a sequence of browser tool calls in ONE round trip. Each item is `{name, input}`
where input is exactly what you'd pass to that tool standalone. Actions execute
SEQUENTIALLY (not in parallel) and stop on the first error. Use this tool extensively to
quickly execute work whenever you can predict two or more steps ahead — e.g. navigate,
click a field, type, press Return, screenshot. Each tool's own permission check runs per
item — if an action navigates to a domain without permission, the next item's check fails
and the batch stops. Screenshots and other images are returned interleaved with outputs;
coordinates you write in THIS batch refer to the screenshot taken BEFORE this call.
browser_batch cannot be nested.

**Parameters:**
- `actions` (array, **required**) — List of tool calls to execute sequentially. Each item
  is `{name, input}`: `name` = tool name (e.g. computer, navigate, find, tabs_create_mcp;
  browser_batch cannot be nested); `input` = that tool's input, same shape you'd pass when
  calling it directly.

---

## computer

Use a mouse and keyboard to interact with a web browser, and take screenshots. If you
don't have a valid tab ID, use tabs_context_mcp first to get available tabs.
- Whenever you intend to click on an element like an icon, you should consult a screenshot
  to determine the coordinates of the element before moving the cursor.
- If you tried clicking on a program or link but it failed to load, even after waiting, try
  adjusting your click location so that the tip of the cursor visually falls on the element
  that you want to click.
- Make sure to click any buttons, links, icons, etc with the cursor tip in the center of
  the element. Don't click boxes on their edges unless asked.

**Parameters:**
- `action` (enum, **required**) — One of:
  - `left_click` — Click the left mouse button at the specified coordinates.
  - `right_click` — Click the right mouse button at the specified coordinates to open context menus.
  - `double_click` — Double-click the left mouse button at the specified coordinates.
  - `triple_click` — Triple-click the left mouse button at the specified coordinates.
  - `type` — Type a string of text.
  - `screenshot` — Take a screenshot of the screen.
  - `wait` — Wait for a specified number of seconds.
  - `scroll` — Scroll up, down, left, or right at the specified coordinates.
  - `key` — Press a specific keyboard key.
  - `left_click_drag` — Drag from start_coordinate to coordinate.
  - `zoom` — Take a screenshot of a specific region for closer inspection.
  - `scroll_to` — Scroll an element into view using its element reference ID from read_page or find tools.
  - `hover` — Move the mouse cursor to the specified coordinates or element without clicking. Reveals tooltips, dropdowns, or hover states.
- `tabId` (number, **required**) — Tab ID to execute the action on. Must be a tab in the current group.
- `coordinate` ([x, y]) — x/y pixels from top-left. Required for left_click, right_click, double_click, triple_click, scroll. For left_click_drag this is the end position.
- `start_coordinate` ([x, y]) — Starting coordinates for left_click_drag.
- `region` ([x0, y0, x1, y1]) — Rectangle to capture for zoom. Required for zoom.
- `text` (string) — Text to type (type action) or key(s) to press (key action). For key: space-separated keys (e.g. "Backspace Backspace Delete"); shortcuts use platform modifier ("cmd+a" on Mac, "ctrl+a" on Win/Linux).
- `modifiers` (string) — Modifier keys for click actions: "ctrl", "shift", "alt", "cmd"/"meta", "win"/"windows". Combine with "+" (e.g. "ctrl+shift").
- `ref` (string) — Element reference ID from read_page/find (e.g. "ref_1"). Required for scroll_to; can substitute for coordinate on click actions.
- `duration` (number, 0–10) — Seconds to wait. Required for wait.
- `repeat` (number, 1–100) — Times to repeat the key sequence (key action only). Default 1.
- `scroll_direction` (enum: up/down/left/right) — Required for scroll.
- `scroll_amount` (number, 1–10) — Scroll wheel ticks. Default 3.
- `save_to_disk` (bool) — For screenshot/zoom: save the image to disk so it can be attached to a message for the user. Returns the saved path.

---

## file_upload

Upload one or multiple files to a file input element on the page. Do not click on file
upload buttons or file inputs — clicking opens a native file picker dialog that you cannot
see or interact with. Instead, use read_page or find to locate the file input element, then
use this tool with its ref to upload files directly. Only files the user has shared with
this session (attachments, the session's outputs/uploads folders, or folders the user has
connected) can be uploaded; other paths will be rejected. The combined size of all files in
a single call must stay under 10 MB.

**Parameters:**
- `paths` (array of strings, **required**) — Absolute paths to the files to upload. Each must be a file the user has shared with this session.
- `ref` (string, **required**) — Element reference ID of the file input from read_page/find (e.g. "ref_1").
- `tabId` (number, **required**) — Tab ID where the file input is located.

---

## find

Find elements on the page using natural language. Can search for elements by their purpose
(e.g., "search bar", "login button") or by text content (e.g., "organic mango product").
Returns up to 20 matching elements with references that can be used with other tools. If
more than 20 matches exist, you'll be notified to use a more specific query. If you don't
have a valid tab ID, use tabs_context_mcp first to get available tabs.

**Parameters:**
- `query` (string, **required**) — Natural language description of what to find (e.g. "search bar", "add to cart button", "product title containing organic").
- `tabId` (number, **required**) — Tab ID to search in. Must be a tab in the current group.

---

## form_input

Set values in form elements using element reference ID from the read_page tool. If you
don't have a valid tab ID, use tabs_context_mcp first to get available tabs.

**Parameters:**
- `ref` (string, **required**) — Element reference ID from read_page (e.g. "ref_1").
- `value` (string | boolean | number, **required**) — Value to set. Checkboxes use boolean, selects use option value or text, other inputs use appropriate string/number.
- `tabId` (number, **required**) — Tab ID to set form value in. Must be a tab in the current group.

---

## get_page_text

Extract raw text content from the page, prioritizing article content. Ideal for reading
articles, blog posts, or other text-heavy pages. Returns plain text without HTML
formatting. If you don't have a valid tab ID, use tabs_context_mcp first to get available
tabs.

**Parameters:**
- `tabId` (number, **required**) — Tab ID to extract text from. Must be a tab in the current group.

---

## gif_creator

Manage GIF recording and export for browser automation sessions. Control when to
start/stop recording browser actions (clicks, scrolls, navigation), then export as an
animated GIF with visual overlays (click indicators, action labels, progress bar,
watermark). All operations are scoped to the tab's group. When starting recording, take a
screenshot immediately after to capture the initial state as the first frame. When stopping
recording, take a screenshot immediately before to capture the final state as the last
frame. For export, either provide 'coordinate' to drag/drop upload to a page element, or
set 'download: true' to download the GIF.

**Parameters:**
- `action` (enum, **required**) — 'start_recording' (begin capturing), 'stop_recording' (stop but keep frames), 'export' (generate and export GIF), 'clear' (discard frames).
- `tabId` (number, **required**) — Tab ID identifying which tab group this operation applies to.
- `download` (bool) — Always set true for the 'export' action only. Downloads the GIF in the browser.
- `filename` (string) — Optional filename for exported GIF (default 'recording-[timestamp].gif'). Export action only.
- `options` (object) — Optional GIF enhancement options for export:
  - `showClickIndicators` (bool) — Orange circles at click locations (default true).
  - `showDragPaths` (bool) — Red arrows for drag actions (default true).
  - `showActionLabels` (bool) — Black labels describing actions (default true).
  - `showProgressBar` (bool) — Orange progress bar at bottom (default true).
  - `showWatermark` (bool) — Claude logo watermark (default true).
  - `quality` (number, 1–30) — Compression quality; lower = better/slower (default 10).

---

## javascript_tool

Execute JavaScript code in the context of the current page. The code runs in the page's
context and can interact with the DOM, window object, and page variables. Returns the
result of the last expression or any thrown errors. If you don't have a valid tab ID, use
tabs_context_mcp first to get available tabs.

**Parameters:**
- `action` (string, **required**) — Must be set to 'javascript_exec'.
- `text` (string, **required**) — JavaScript to execute. REPL semantics: top-level `await` works and the last expression's value is returned automatically — write the expression (e.g. `window.myData.value`) rather than `return ...`.
- `tabId` (number, **required**) — Tab ID to execute the code in. Must be a tab in the current group.

---

## list_connected_browsers

List all Chrome browsers (extension instances) currently connected to this account.
Returns each browser's deviceId, display name, OS platform, and whether it appears to be on
this computer. Use this before select_browser to present choices to the user. Before any
browser action, you MUST call the AskUserQuestion tool with a question listing EVERY
connected browser as a separate option (use the display name as the label, and include the
deviceId in parentheses), plus one final option labeled exactly: "Open a confirmation
screen in every connected Chrome extension and let me select the right one there." Do not
skip any connected browser and do not pick one yourself. If the user picks a specific
browser, call select_browser with that browser's deviceId. If the user picks the final
option, call switch_browser — this sends a confirmation prompt to every connected Chrome
extension and waits for the user to click Connect in the one they want; it also lets them
name that browser.

**Parameters:** none.

---

## navigate

Navigate to a URL, or go forward/back in browser history. If you don't have a valid tab ID,
use tabs_context_mcp first to get available tabs.

**Parameters:**
- `url` (string, **required**) — URL to navigate to (protocol optional, defaults to https://). Use "forward"/"back" to move in history.
- `tabId` (number, **required**) — Tab ID to navigate. Must be a tab in the current group.

---

## read_console_messages

Read browser console messages (console.log, console.error, console.warn, etc.) from a
specific tab. Useful for debugging JavaScript errors, viewing application logs, or
understanding what's happening in the browser console. Returns console messages from the
current domain only. If you don't have a valid tab ID, use tabs_context_mcp first to get
available tabs. IMPORTANT: Always provide a pattern to filter messages — without a pattern,
you may get too many irrelevant messages.

**Parameters:**
- `tabId` (number, **required**) — Tab ID to read console messages from. Must be a tab in the current group.
- `pattern` (string) — Regex to filter messages (e.g. 'error|warning', 'MyApp'). Always provide one to avoid noise.
- `onlyErrors` (bool) — If true, only error/exception messages. Default false.
- `limit` (number) — Max messages to return. Default 100.
- `clear` (bool) — If true, clear messages after reading to avoid duplicates next call. Default false.

---

## read_network_requests

Read HTTP network requests (XHR, Fetch, documents, images, etc.) from a specific tab.
Useful for debugging API calls, monitoring network activity, or understanding what requests
a page is making. Returns all network requests made by the current page, including
cross-origin requests. Requests are automatically cleared when the page navigates to a
different domain. If you don't have a valid tab ID, use tabs_context_mcp first to get
available tabs.

**Parameters:**
- `tabId` (number, **required**) — Tab ID to read network requests from. Must be a tab in the current group.
- `urlPattern` (string) — Only requests whose URL contains this string (e.g. '/api/', 'example.com').
- `limit` (number) — Max requests to return. Default 100.
- `clear` (bool) — If true, clear requests after reading. Default false.

---

## read_page

Get an accessibility tree representation of elements on the page. By default returns all
elements including non-visible ones. Output is limited to 50000 characters by default. If
the output exceeds this limit, you will receive an error asking you to specify a smaller
depth or focus on a specific element using ref_id. Optionally filter for only interactive
elements. If you don't have a valid tab ID, use tabs_context_mcp first to get available
tabs.

**Parameters:**
- `tabId` (number, **required**) — Tab ID to read from. Must be a tab in the current group.
- `filter` (enum: interactive/all) — "interactive" for buttons/links/inputs only; "all" for all elements incl. non-visible (default).
- `depth` (number) — Max tree depth to traverse (default 15). Use smaller if output too large.
- `ref_id` (string) — Reference ID of a parent element; returns it and all children. Use to focus when output is too large.
- `max_chars` (number) — Max characters for output (default 50000). Raise if your client handles large output.

---

## resize_window

Resize the current browser window to specified dimensions. Useful for testing responsive
designs or setting up specific screen sizes. If you don't have a valid tab ID, use
tabs_context_mcp first to get available tabs.

**Parameters:**
- `width` (number, **required**) — Target window width in pixels.
- `height` (number, **required**) — Target window height in pixels.
- `tabId` (number, **required**) — Tab ID to get the window for. Must be a tab in the current group.

---

## select_browser

Select a specific Chrome browser by deviceId for browser automation, without broadcasting a
pairing request. Use this after list_connected_browsers when the user has chosen one from
the list.

**Parameters:**
- `deviceId` (string, **required**) — The deviceId from list_connected_browsers.

---

## shortcuts_execute

Execute a shortcut or workflow by running it in a new sidepanel window using the current
tab (shortcuts and workflows are interchangeable). Use shortcuts_list first to see available
shortcuts. This starts the execution and returns immediately — it does not wait for
completion.

**Parameters:**
- `tabId` (number, **required**) — Tab ID to execute the shortcut on. Must be a tab in the current group.
- `command` (string) — Command name of the shortcut (e.g. 'debug', 'summarize'), without leading slash.
- `shortcutId` (string) — The ID of the shortcut to execute.

---

## shortcuts_list

List all available shortcuts and workflows (shortcuts and workflows are interchangeable).
Returns shortcuts with their commands, descriptions, and whether they are workflows. Use
shortcuts_execute to run a shortcut or workflow.

**Parameters:**
- `tabId` (number, **required**) — Tab ID to list shortcuts from. Must be a tab in the current group.

---

## switch_browser

Send a connection request to every Chrome browser with the extension installed and wait (up
to 2 minutes) for the user to click 'Connect' in the one they want to use. The user can name
the browser when they connect. Use this when the user wants to pick the browser themselves
from inside Chrome rather than choosing from a list; otherwise prefer select_browser with a
known deviceId.

**Parameters:** none.

---

## tabs_close_mcp

Close a tab in the MCP tab group by its ID. Use to clean up tabs you're done with. Only tabs
in this session's group are closable; call tabs_context_mcp first to get valid IDs. If you
close the group's last tab, Chrome auto-removes the group — the next tabs_context_mcp with
createIfEmpty starts fresh.

**Parameters:**
- `tabId` (integer, **required**) — The ID of the tab to close. Must be in this session's tab group.

---

## tabs_context_mcp

Get context information about the current MCP tab group. Returns all tab IDs inside the
group if it exists. CRITICAL: You must get the context at least once before using other
browser automation tools so you know what tabs exist. Each new conversation should create
its own new tab (using tabs_create_mcp) rather than reusing existing tabs, unless the user
explicitly asks to use an existing tab.

**Parameters:**
- `createIfEmpty` (bool) — If no group exists, creates a new Window with a new tab group containing an empty tab for this conversation. No effect if a group already exists.

---

## tabs_create_mcp

Creates a new empty tab in the MCP tab group. CRITICAL: You must get the context using
tabs_context_mcp at least once before using other browser automation tools so you know what
tabs exist.

**Parameters:** none.

---

## upload_image

Upload a previously captured screenshot or user-uploaded image to a file input or drag &
drop target. Supports two approaches: (1) ref — for targeting specific elements, especially
hidden file inputs, (2) coordinate — for drag & drop to visible locations like Google Docs.
Provide either ref or coordinate, not both.

**Parameters:**
- `imageId` (string, **required**) — ID of a previously captured screenshot (from computer tool's screenshot action) or a user-uploaded image.
- `tabId` (number, **required**) — Tab ID where the target element is located; where the image is uploaded to.
- `ref` (string) — Element reference ID from read_page/find (e.g. "ref_1"). Use for file inputs (esp. hidden) or specific elements. Provide either ref or coordinate, not both.
- `coordinate` ([x, y]) — Viewport coordinates for drag & drop to a visible location (e.g. Google Docs). Provide either ref or coordinate, not both.
- `filename` (string) — Optional filename for the uploaded file (default "image.png").

---

## How to regenerate

These schemas live in the running Claude Code / Chrome-extension bridge, not on disk, so
there is no config file to `cat` and `claude mcp get claude-in-chrome` returns
"No MCP server named claude-in-chrome". To refresh this file, ask Claude Code to
"dump the claude-in-chrome tool schemas to a file" — it pulls the live schemas (via the
harness ToolSearch) and rewrites this document.

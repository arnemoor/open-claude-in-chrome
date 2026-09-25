# Open Claude in Chrome — Integration Test Prompt

Copy and paste everything below the line into a new Claude Code session that has the `open-claude-in-chrome` MCP configured.

---

You are running an integration test for a Chrome browser automation extension. Your job is to execute every step below and use the specific MCP tool listed for each step. Do NOT skip any tool. Every single one must be called at least once. The one exception is `file_upload`, which this prompt does not call (see the Upload section).

Execute these steps in order:

## Tab Management
1. Call `tabs_context_mcp` with `createIfEmpty: true` to get current tabs.
2. Call `tabs_create_mcp` to create a new tab. Record its tab ID as TAB_1.
3. Call `tabs_create_mcp` again to create a second tab. Record its tab ID as TAB_2.

## Navigation + Window
4. Call `navigate` to go to `https://www.reddit.com` in TAB_1. (This domain is blocked in the official Claude in Chrome extension — if this works, the unblocked extension is functioning.)
5. Call `resize_window` to set the window to 1280x800 using TAB_1.

## Screenshots + Reading
6. Call `computer` with action `screenshot` on TAB_1.
7. Call `read_page` on TAB_1 with filter `"all"` to get the accessibility tree.
8. Call `get_page_text` on TAB_1 to extract the text content.

## Finding + Form Input
9. Call `find` with query `"search"` on TAB_1 to locate the search input.
10. Call `form_input` on TAB_1 using the ref from step 9 to set the search value to `"MCP server"`.

## Mouse + Keyboard Actions
11. Call `computer` with action `left_click` on TAB_1 at the coordinates of the search input (from step 9).
12. Call `computer` with action `key` on TAB_1 with text `"Enter"` to submit the search.
13. Call `computer` with action `wait` on TAB_1 with duration `3` to wait for results.
14. Call `computer` with action `scroll` on TAB_1 with scroll_direction `"down"` and scroll_amount `3` at coordinates `[640, 400]`.
15. Call `computer` with action `hover` on TAB_1 at coordinates `[640, 300]`.
16. Call `computer` with action `double_click` on TAB_1 at coordinates `[640, 300]`.
17. Call `computer` with action `triple_click` on TAB_1 at coordinates `[640, 300]`.
18. Call `computer` with action `right_click` on TAB_1 at coordinates `[640, 300]`.
19. Call `computer` with action `type` on TAB_1 with text `"integration test"`.
20. Call `computer` with action `scroll_to` on TAB_1 at coordinates `[0, 0]`.

## JavaScript + Debug
21. Call `javascript_tool` on TAB_1 with action `"javascript_exec"` and text `"document.querySelectorAll('a').length"`.
22. Call `read_console_messages` on TAB_1 with pattern `".*"`.
23. Call `read_network_requests` on TAB_1.

## Second Tab
24. Call `navigate` to go to `https://news.ycombinator.com` in TAB_2.
25. Call `computer` with action `screenshot` on TAB_2.

## Drag
26. Call `computer` with action `left_click_drag` on TAB_1 with start_coordinate `[100, 300]` and coordinate `[400, 300]`.

## Zoom
27. Call `computer` with action `zoom` on TAB_1 with region `[0, 0, 640, 400]`.

## Batch
28. Call `browser_batch` on TAB_1 with two actions in one round trip: `computer` `scroll` (scroll_direction `"up"`, scroll_amount `2`, coordinates `[640, 400]`) followed by `computer` `screenshot`.

## Stub Tools (call them — they should return gracefully)
29. Call `gif_creator` with action `"start_recording"` on TAB_1.
30. Call `shortcuts_list` on TAB_1.
31. Call `shortcuts_execute` on TAB_1 with command `"test"`.
32. Call `switch_browser`.
33. Call `list_connected_browsers`.
34. Call `select_browser` with deviceId `"test-device-id"` (a stub, so any string works).

## Upload
35. Call `computer` with action `screenshot` on TAB_1 with `save_to_disk: true`.
36. Call `upload_image` on TAB_1 with the imageId from your first screenshot (step 6), using ref from step 9.

This prompt does not call `file_upload`. The tool needs a file input on a page that the extension can script, and a `data:` page does not work for that. Chrome does not load a `data:` URL that `navigate` opens, and the extension cannot run its content script in a `data:` page. The automated end-to-end check covers `file_upload` instead (test/e2e/e2e.mjs, step 6).

## Cleanup
37. Call `tabs_close_mcp` to close TAB_2.

## Validation

Now produce a final report. List every one of the 22 tools below and whether you successfully called it during this test. Use this exact format:

```
INTEGRATION TEST RESULTS
========================
1.  tabs_context_mcp        : [PASS/FAIL] — step(s) used
2.  tabs_create_mcp          : [PASS/FAIL] — step(s) used
3.  navigate                 : [PASS/FAIL] — step(s) used
4.  computer                 : [PASS/FAIL] — step(s) used (list actions exercised)
5.  browser_batch             : [PASS/FAIL] — step(s) used
6.  find                     : [PASS/FAIL] — step(s) used
7.  form_input               : [PASS/FAIL] — step(s) used
8.  get_page_text            : [PASS/FAIL] — step(s) used
9.  gif_creator              : [PASS/FAIL] — step(s) used
10. javascript_tool          : [PASS/FAIL] — step(s) used
11. read_console_messages    : [PASS/FAIL] — step(s) used
12. read_network_requests    : [PASS/FAIL] — step(s) used
13. read_page                : [PASS/FAIL] — step(s) used
14. resize_window            : [PASS/FAIL] — step(s) used
15. shortcuts_list           : [PASS/FAIL] — step(s) used
16. shortcuts_execute        : [PASS/FAIL] — step(s) used
17. switch_browser           : [PASS/FAIL] — step(s) used
18. list_connected_browsers  : [PASS/FAIL] — step(s) used
19. select_browser           : [PASS/FAIL] — step(s) used
20. file_upload              : NOT CALLED (covered by test/e2e/e2e.mjs step 6)
21. upload_image             : [PASS/FAIL] — step(s) used
22. tabs_close_mcp           : [PASS/FAIL] — step(s) used

Computer actions exercised:
- screenshot: [PASS/FAIL]
- left_click: [PASS/FAIL]
- right_click: [PASS/FAIL]
- double_click: [PASS/FAIL]
- triple_click: [PASS/FAIL]
- hover: [PASS/FAIL]
- type: [PASS/FAIL]
- key: [PASS/FAIL]
- scroll: [PASS/FAIL]
- scroll_to: [PASS/FAIL]
- wait: [PASS/FAIL]
- left_click_drag: [PASS/FAIL]
- zoom: [PASS/FAIL]

OVERALL: [PASS if the other 21 tools were called / FAIL if any missed]
```

Mark a tool as PASS only if you actually called it and received a response (even if the response was "not implemented" for stub tools). Mark it as FAIL if you skipped it or encountered an error that prevented the call.

If OVERALL is FAIL, list which tools failed and why.

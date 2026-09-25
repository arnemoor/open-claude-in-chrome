<p align="center">
  <img src="extension/icons/icon128.png" width="96" alt="Open Claude in Chrome">
</p>

<h1 align="center">Open Claude in Chrome</h1>

<p align="center">
  <em>Official Claude in Chrome gives you 58 blocked domains and two browsers.<br/>
  <strong>Open Claude in Chrome gives you the whole web.</strong></em>
  <br/>
  <sub>Clean-room reimplementation of Anthropic's browser extension. No blocklist. Chrome, Edge and Brave. The full 22-tool surface.</sub>
  <br/>
  <sub>by <a href="https://noemica.io">noemica</a></sub>
</p>

<p align="center">
  <a href="#whats-different">What's different</a> ·
  <a href="#installation">Install</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="https://youtu.be/n4-2fjOsGhw">Demo</a> ·
  <a href="https://www.noemica.io/blog/reverse-engineered-claude-in-chrome">How I built it</a>
</p>

---

<p align="center">
  <a href="https://youtu.be/n4-2fjOsGhw">
    <img src="https://img.youtube.com/vi/n4-2fjOsGhw/maxresdefault.jpg" alt="Demo — Claude on Tinder, Reddit, and Robinhood" width="820"/>
  </a>
  <br/>
  <sub><em>Watch Claude navigate Tinder, Reddit, and Robinhood — sites the official extension can't reach.</em></sub>
</p>

---

The official [Claude in Chrome](https://code.claude.com/docs/en/chrome) extension gives Claude Code full browser automation — as long as you stay within Anthropic's allowlist of "safe" sites. Open Claude in Chrome is a clean-room reimplementation that strips the restrictions while exposing the same 22-tool surface as the official extension and matching its performance.

## What's Different

| | Claude in Chrome | Open Claude in Chrome |
|---|---|---|
| **Domain blocklist** | 58 blocked domains across 11 categories | No blocklist. Navigate anywhere. |
| **Browser support** | Chrome and Edge only | Chrome, Edge and Brave |
| **Source code** | Closed source | Open source (MIT) |
| **Tools** | 22 MCP tools | Same 22-tool surface (a few advanced tools are stubs, see below) |
| **Performance** | Baseline | Identical |

### Blocked Domains in the Official Extension

| Category | Blocked Sites |
|----------|--------------|
| Banking | Chase, BofA, Wells Fargo, Citibank |
| Investing/Brokerage | Schwab, Fidelity, Robinhood, E-Trade, Wealthfront, Betterment |
| Payments/Transfers | PayPal, Venmo, Cash App, Zelle, Stripe, Square, Wise, Western Union, MoneyGram, Adyen, Checkout.com |
| BNPL | Klarna, Affirm, Afterpay |
| Neobanks/Fintech | SoFi, Chime, Mercury, Brex, Ramp |
| Crypto | Coinbase, Binance, Kraken, MetaMask |
| Gambling | DraftKings, FanDuel, Bet365, Bovada, PokerStars, BetMGM, Caesars |
| Dating | Tinder, Bumble, Hinge, Match, OKCupid |
| Adult | Pornhub, XVideos, XNXX |
| News/Media | NYT, WSJ, Barron's, MarketWatch, Bloomberg, Reuters, Economist, Wired, Vogue |
| Social Media | Reddit |

Open Claude in Chrome has **none of these restrictions**.

## Architecture

```
Claude Code <--stdio MCP--> mcp-server.js <--Unix socket--> native-host.js <--native messaging--> Extension <--> Browser
```

Three components:
1. **Extension** — Manifest V3 with CDP-based browser automation (all 22 tools)
2. **MCP Server** — Node.js process started by Claude Code, exposes tools via MCP
3. **Native Messaging Host** — owns the bridge and relays between MCP servers and the extension

The native host is spawned by the browser and owns the bridge, called the hub. It listens on a Unix domain socket at `~/.config/open-claude-in-chrome/run/bridge.sock`, inside a directory it creates with mode `0700` and tightens back to `0700` on every start. Any number of MCP servers, across any number of Claude Code sessions, connect to that socket as clients. Ownership of the directory (yours, not a symlink, not open to other users) is what makes a connecting client trustworthy: any local process able to open the socket is already running as you, so nothing further needs to be proven.

If more than one native host tries to serve that socket at the same time (for example Chrome and Brave both running with the extension loaded), only one of them becomes the hub. The others wait and take over automatically if it exits, but only the current hub's browser is reachable by the tools at any moment.

## Upgrading from the old TCP version

Earlier releases of Open Claude in Chrome connected the MCP server to the native host over a loopback TCP port (default 18765, configurable through `config.json`), authenticated with a shared secret file at `~/.config/open-claude-in-chrome/token`. The first MCP server to start owned that port, later sessions connected to it as clients, and one of them would take over if it exited. None of that exists anymore. The native host now owns a per-user Unix socket directly (see Architecture above), so there is no port to pick, no secret file to protect, and no session to promote.

To move an existing install to this version:

1. Pull the latest code.
2. Reinstall host dependencies: `cd host && npm install && cd ..`.
3. Quit the browser with Cmd+Q, or at least reload the extension (next step). Closing every window alone does not quit a Chrome-based browser, which keeps running in the background. Either way, both sides need to restart together: an old native host and a new MCP server (or the other way around) cannot talk to each other.
4. Reload the extension in `chrome://extensions` so it picks up the new `background.js` and `content.js`. After the reload, or after a browser restart, the extension does not reuse the old MCP tab group, and a call on one of its tab ids is refused. Only the next `tabs_context_mcp` with `createIfEmpty: true`, or a `tabs_create_mcp`, creates a new group. You can close the old group by hand (see Troubleshooting).
5. Clear out stale MCP server processes and reconnect each Claude Code session:
   ```bash
   pkill -f "node.*open-claude-in-chrome/host/mcp-server"
   ```
   then run `/mcp` in each session.
6. Re-run `./install.sh <your-extension-id>` (the same IDs from your original install) to link the new agent skill into `~/.claude/skills` (see Installation, Step 3).

No manual cleanup is required beyond that. A leftover `port` key in `~/.config/open-claude-in-chrome/config.json` is simply ignored now (that file's only remaining job is `fileUploadAllowedDirs`, see below), and `~/.config/open-claude-in-chrome/token` is no longer read. You can confirm nothing from the old version is still listening with `lsof -iTCP:<port>` (the port from your old `config.json`, 18765 by default). Either file can stay or be deleted.

## Installation

### Prerequisites

- **Node.js** v18+
- **Google Chrome, Microsoft Edge or Brave**. `install.sh` registers the native messaging host for these three browsers only.
- **Claude Code** v2.0.73+

### Step 1: Install dependencies

```bash
cd host
npm install
cd ..
```

### Step 2: Load the extension

1. Go to `chrome://extensions` (or `brave://extensions` / `edge://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `extension/` directory
4. Copy the **extension ID** shown under the extension name

### Step 3: Register native messaging

```bash
./install.sh <your-extension-id>
```

If you use multiple browsers, pass all IDs:

```bash
./install.sh <chrome-id> <edge-id> <brave-id>
```

This also links an agent-facing skill describing this fork's tool quirks into `~/.claude/skills/open-claude-in-chrome`, as long as `~/.claude/skills` already exists on your machine.

### Step 4: Restart your browser

Quit with **Cmd+Q**, or at least reload the extension in `chrome://extensions`. Closing every window alone does not quit a Chrome-based browser, which keeps running in the background. Either way, this is what makes the browser pick up the native messaging host config from Step 3.

### Step 5: Add to Claude Code

```bash
claude mcp add open-claude-in-chrome -- node /absolute/path/to/host/mcp-server.js
```

To print this command for your checkout, run this from the repository root. It puts the path in single quotes, the same way `install.sh` prints it at the end, so a path with spaces or other special characters pastes as is:

```bash
printf "claude mcp add open-claude-in-chrome -- node '%s'\n" "$(pwd | sed "s/'/'\\\\''/g")/host/mcp-server.js"
```

## Verification

Start a new Claude Code session and test:

```
Navigate to reddit.com and take a screenshot
```

Reddit loads. No domain restriction.

## Available Tools

The full 22-tool surface of the official Claude in Chrome. Most are fully implemented. A few advanced tools that depend on Anthropic-proprietary or multi-browser infrastructure are honest stubs — they return a clear "not supported" message rather than fake success.

| Tool | Description |
|------|-------------|
| `tabs_context_mcp` | Get tab group context |
| `tabs_create_mcp` | Create new tab |
| `tabs_close_mcp` | Close a tab in the group |
| `navigate` | Navigate to URL, back, forward |
| `computer` | Mouse, keyboard, screenshots (13 actions, `save_to_disk` on `screenshot`/`zoom` saves to disk, see below) |
| `browser_batch` | Run a sequence of tool calls in one round trip |
| `read_page` | Accessibility tree with element refs |
| `get_page_text` | Extract article/main text |
| `find` | Find elements by text/attributes |
| `form_input` | Set form values by ref |
| `javascript_tool` | Execute JS in page context |
| `read_console_messages` | Console output (filtered) |
| `read_network_requests` | Network activity |
| `resize_window` | Resize browser window |
| `file_upload` | Upload local files to a file input by ref (allowed folders only, see below) |
| `upload_image` | Upload a captured screenshot to a file input (best-effort) |
| `gif_creator` | GIF recording (stub) |
| `shortcuts_list` | List shortcuts (stub) |
| `shortcuts_execute` | Run shortcut (stub) |
| `switch_browser` | Switch browser (stub) |
| `list_connected_browsers` | List connected browsers (stub) |
| `select_browser` | Select browser by deviceId (stub) |

## Uploading and saving files

`file_upload`, including a `file_upload` action nested inside `browser_batch`, only accepts absolute paths inside an allowed upload folder. By default that's `~/Downloads` and `~/Desktop`. Set `fileUploadAllowedDirs` in `~/.config/open-claude-in-chrome/config.json` to use different folders instead, not in addition: once it's set, only the folders you list are allowed, and the refusal names them. This allowlist is the only path by which a local file's bytes can reach the browser at all: `navigate` refuses `file://` URLs outright (see Tool behavior notes below), so there's no way around it by opening a file as a page instead.

```json
{ "fileUploadAllowedDirs": ["~/Downloads", "~/Projects/shared-uploads"] }
```

Only a leading `~/` expands to your home directory. A bare `~` is left as a relative path and ignored, with a warning. A path outside the allowed folders, or a symlink that resolves outside them, is refused. If the config file exists but is invalid (bad JSON, or `fileUploadAllowedDirs` set to something other than an array), every upload is refused until it's fixed, and the error message says what to fix. The 10 MB combined-size limit applies per `file_upload` action, including inside `browser_batch`, where each nested `file_upload` action is checked, and limited, on its own.

`computer`'s `screenshot` and `zoom` actions take a `save_to_disk: true` argument. The MCP server, not the extension, writes the image to `~/Downloads/open-claude-in-chrome/` (folder mode `0700`, files mode `0600`) and reports the saved path in the reply. The extension no longer needs, or requests, Chrome's `downloads` permission.

macOS privacy protection (TCC) covers `~/Downloads` and `~/Desktop`. `save_to_disk` runs entirely in the MCP server, a child process of whatever terminal or app started Claude Code, so if that app has no Files and Folders access, it comes back with an `EPERM` error in the tool reply instead of writing anything. `file_upload` is checked by the MCP server the same way, but the browser itself then reads the file to attach it to the page, so the browser app (Chrome, Brave, Edge) needs that same folder access too, independently of the terminal or Claude app (see Troubleshooting).

## Tool behavior notes

A few things about `computer` and `navigate` that aren't obvious from the tool descriptions alone.

**navigate.** A bare host like `example.com` gets `https://` added automatically. These schemes are kept exactly as given: `http:`, `https:`, `data:`, `about:`, `chrome:`, `brave:`, `edge:`, `view-source:`, `blob:`, `ftp:`, and `chrome-extension:` for another extension's id. Anything else with a 1-5 letter scheme followed by a slash is treated as a mistyped protocol: that prefix is stripped and `https://` takes its place (`ws://h` becomes `https://h`). A longer or different unknown scheme instead gets `https://` prefixed onto the whole original string (`webcal://h` becomes `https://webcal://h`, `mailto:a@b` becomes `https://mailto:a@b`), so don't rely on an unlisted scheme surviving as written. `javascript:` URLs are refused (use `javascript_tool` instead), and so is navigating to this extension's own pages, even wrapped in `view-source:` or `blob:`. That unwrapping only guards the extension's own pages: a `javascript:` URL hidden behind `view-source:`, for example `view-source:javascript:alert(1)`, is not caught by the `javascript:` refusal itself.

**Local files.** `file:` URLs are blocked outright, also when wrapped in `view-source:` or `blob:`: the reply is `file: URLs are blocked: the agent cannot open local files.` This is by design, not a missing permission. Chrome grants unpacked extensions access to `file://` pages by default, and once granted, a page read (`get_page_text`, `read_page`, a screenshot) would let the agent pull the contents of any file the browser can read, regardless of what `fileUploadAllowedDirs` says. Turning on "Allow access to file URLs" for this extension in `chrome://extensions` does not change this behavior. You can still turn that switch off there for defense in depth. Every other tool except `tabs_close_mcp` also refuses to act on a tab that's currently showing a `file://` page or one of this extension's own pages: the reply is `Tab <id> shows a local file or this extension's own page, which the agent cannot use.` `tabs_close_mcp` can still close such a tab, so the agent can clean it up.

**Typing and keys.** `type` presses real keys, with real keydown/keyup events, only for characters on a US keyboard layout (letters, digits, common punctuation). Every other character (umlauts, ß, emoji, CJK) is inserted as text instead, one character at a time, with no key events at all, though the field's value ends up exactly right either way. A line break in the typed text becomes a real line break only when a `textarea` or a contenteditable element is focused. In a single-line `<input>` it's dropped, and the reply notes that. Use the `key` action with `text: "Enter"` to submit a form. Some shifted punctuation can't be built as a `key` combination (for example `shift+1` presses Shift and 1, not `!`). Type that character directly instead.

**Clicking.** A click reply names what it hit, for example `Clicked at (120, 40) on button#submit "Sign in".` On a page where no content script can run at all (a certificate interstitial, a network error page), the click still goes ahead but the reply has no "on …" clause at all. Compare that name, when there is one, against what you meant to click. Only a **ref** click (`ref` from `read_page` or `find`) additionally warns `Warning: The click point is covered by …` when something else is stacked on top. A plain coordinate click never gets that specific warning, but it can still carry a label note (for example a disabled or unassociated control), so check both the name and any note. A coordinate outside the current viewport is refused outright (`Scroll first or use a ref`). Clicking by element `ref` scrolls it into view instead and says so in the reply, since any coordinate read from an earlier screenshot is now stale.

## Audit mode

The extension can keep a local, opt-in audit log of what an agent does in the browser, for the user's own oversight. It's off by default. Only the extension's own options page (`chrome://extensions` > Open Claude in Chrome > Details > Extension options) can turn it on or change its retention period (1, 7 or 30 days). No MCP tool can read or change this setting. An audit failure never changes a tool's result, and audit writes happen in the background, except that the first audited call on a given page can wait up to about 2 seconds while that page's recorder starts.

When it's on, each session's tool calls are recorded as a redacted summary. `type` text and `form_input` values are kept only as a character count, never the value, but a boolean form value is kept as `checked=true` or `checked=false`. A `key` action keeps named keys and modifier combos (like `Enter` or `ctrl+a`) as given, since they aren't secrets, but a run of plain character keys is stored only as a count (`[N keys]`), the same protection `type` gets. Query strings and fragments are removed from every stored URL, from the action summaries and from error texts. That includes a URL inside a `find` query and a URL inside `javascript_tool` code, even in a comment. The path stays. `javascript_tool` code is kept up to 500 characters, but the text of any string literal inside it is replaced with `[N chars]`, and so is everything after the first `/` that isn't part of a comment (a division sign or the start of a regex), since telling those apart isn't reliable. Apart from that URL rule, `find` queries and file paths (upload paths, URL paths) are kept as given.

Alongside that summary, a masked DOM replay (via rrweb, not a screen recording) of the tabs the session touched masks every input, textarea, select and password value, and any contenteditable text, to asterisks of the same length. Only those values are masked. All other page text is recorded as it is, link text included. So when a page copies what is typed into an ordinary element, for example a live preview of a message, the replay records that copy as page text. Hidden inputs are left out of the replay entirely. A URL captured in the replay itself, the page's own address or a link's href, also has its query and fragment stripped, but a URL written in the page text keeps them. It doesn't inline canvas content or images, and a page this extension can't script at all (a `chrome://` page, the Web Store) gets no replay. Only tabs in the MCP tab group are ever recorded. Viewing a replay never loads anything over the network: the options page only ever uses its own bundled resources.

Everything lives in the browser profile's own IndexedDB and never leaves the machine. Entries older than the retention period are deleted every hour and each time the browser starts, even after audit mode is switched off, as long as it was ever turned on, and at most 200 sessions are kept regardless of age.

The options page lists sessions by label, working directory, pid, first and last seen, action count and tab count. Each native-host run gives every connecting agent its own session row, so a browser restart shows up as new rows rather than a continuation of the old ones. Clicking a session shows its action list and a replay player with a tab selector, plus buttons to export that session as JSON or delete it.

This is meant for oversight, not as tamper-proof forensic evidence. It's ordinary browser-profile storage, not a signed or write-once log.

## Logs

The native host and every MCP server write JSON-lines logs under `~/.config/open-claude-in-chrome/logs/` (folder mode `0700`, files mode `0600`). The native host has its own `native-host.log`. Every MCP server process, across every Claude Code session, appends to the same shared `mcp-server.log`, with each line's `pid` field identifying which one wrote it. Entries are lifecycle events only, things like a hub starting, a client connecting, or a process exiting and why. Tool arguments and results are never written there. Each file is capped at about 1 MB and rotates to a single `.log.1` generation (for example `native-host.log.1`), so at most roughly 2 MB of history is kept per file. These logs are the only durable record of what the native host or an MCP server did between restarts, worth checking when something in Troubleshooting below doesn't explain itself.

## Updating After Code Changes

No build step. All files are plain JavaScript. After pulling or editing code:

| What changed | What to do |
|---|---|
| `extension/background.js`, `extension/content.js`, `extension/manifest.json`, anything under `extension/audit/` or `extension/vendor/`, or the `extension/options.*` files | Reload the extension: `brave://extensions` > click the reload icon |
| `host/*.js` (`native-host.js`, `mcp-server.js`, `bridge-hub.js`, `bridge-client.js`, `bridge-endpoint.js`, `log.js`) | Quit the browser completely with Cmd+Q, or reload the extension (either starts a new native host), then `pkill -f "node.*open-claude-in-chrome/host/mcp-server"` and `/mcp` in each Claude Code session |
| `host/upload-policy.js`, `host/save-to-disk.js` | `pkill -f "node.*open-claude-in-chrome/host/mcp-server"` and `/mcp` in each Claude Code session, no browser restart needed |
| `install.sh` or native host name changed | Re-run `./install.sh <extension-id>`, quit the browser completely with Cmd+Q or reload the extension, re-add MCP |

> Old and new versions of the bridge cannot talk to each other, so after changing `native-host.js`, `mcp-server.js`, `bridge-hub.js`, `bridge-client.js`, `bridge-endpoint.js` or `log.js`, refresh **both** sides: quit the browser completely with Cmd+Q, or reload the extension (either spawns a fresh native host), **and** `pkill` + `/mcp` in every session (spawns fresh MCP servers). Closing every window does not quit a Chrome-based browser. `log.js` is imported by the native host too, so a change there only reaches `native-host.log` once a fresh native host starts. Reloading the extension also applies any manifest change (a dropped or added permission, a new options page, and so on).

### Quick reset (nuclear option)

If things are broken and you're not sure why:

```bash
# 1. Kill all MCP servers
pkill -f "node.*open-claude-in-chrome/host/mcp-server"

# 2. Re-run install
./install.sh <your-extension-id>

# 3. Quit the browser completely (Cmd+Q) and reopen it, or at least do step 4.
#    Closing every window does not quit a Chrome-based browser.

# 4. Reload extension in brave://extensions

# 5. Reconnect in Claude Code
# /mcp
```

## Multiple Sessions

Any number of Claude Code sessions can share the same browser. Each session's MCP server connects to the native host's hub as an equal client. No client owns the link, so one session ending never disconnects the others, and none needs to be promoted when another exits. All sessions also share one MCP tab group, so each session can see and act on the other sessions' tabs, even though the `tabs_close_mcp` tool description speaks of "this session's group".

## Troubleshooting

### Extension not connecting

1. Verify the extension is loaded and enabled
2. Check that `./install.sh` was run with the correct extension ID
3. Quit the browser completely with Cmd+Q and reopen it, or reload the extension in `chrome://extensions`. Closing every window does not quit a Chrome-based browser.
4. Verify the native messaging host manifest exists:
   - **Chrome (macOS)**: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.anthropic.open_claude_in_chrome.json`
   - **Brave (macOS)**: `~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.anthropic.open_claude_in_chrome.json`
   - **Edge (macOS)**: `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.anthropic.open_claude_in_chrome.json`

### MCP server not found

Use an absolute path:
```bash
claude mcp add open-claude-in-chrome -- node /absolute/path/to/host/mcp-server.js
```

### "Browser extension is not connected"

The MCP server is running, but no native host is serving the bridge socket. Check, in order:
1. **Is the browser running?** The extension and its native host only exist while the browser is open — no browser means no connection.
2. Open any webpage to wake the service worker.
3. Reload the extension in `chrome://extensions`. A fresh service worker starts a new native host, which serves the socket again, and the MCP servers reconnect on their own.
4. Check service worker logs: `chrome://extensions` > "Inspect views: service worker".
5. Verify `host/native-host-wrapper.sh` exists and its `node` path is valid.

### A second MCP tab group after a reload or restart

The extension reuses only the tab group it created itself. It remembers that group's id in the browser's session storage, which the browser clears on every extension reload or update and on every browser restart. It never takes over a group because the group is titled "MCP", so a group of your own with that title stays yours. After a reload or restart, the old MCP group is therefore not reused, and a call on one of its tab ids is refused. Only the next `tabs_context_mcp` with `createIfEmpty: true`, or a `tabs_create_mcp`, creates a new group. Close the old group by hand once you no longer need its tabs.

### Socket permission error

The native host creates `~/.config/open-claude-in-chrome/run` with mode `0700` each time it starts, and tightens it back to `0700` automatically if it finds looser permissions there, as long as the directory is a real directory you own. It refuses to serve the bridge instead, and logs why as a `start_failed` entry in `~/.config/open-claude-in-chrome/logs/native-host.log`, only when the path genuinely isn't usable:

- the run directory is a symlink, a plain file, or owned by someone else
- its parent directory can't be created or reached at all
- something other than a socket already sits at the `bridge.sock` path itself
- the full socket path is too long for a Unix socket (over 103 bytes on macOS, 107 on Linux, which a long home directory path can trigger)

Remove or fix whatever is at that path (or shorten your home directory path), then quit the browser completely with Cmd+Q, or reload the extension.

### `navigate` refuses `file://` URLs

This is by design, not a bug or a missing setting: see Tool behavior notes above. There's no config flag or extension permission that turns it back on, including "Allow access to file URLs" in `chrome://extensions`. If you need to work with a local file in the browser yourself, open it in a regular tab outside the agent's control. The agent can't navigate there, and can't act on a tab that's already showing one, except to close it.

### EPERM on `save_to_disk` or `file_upload`

macOS protects `~/Downloads` and `~/Desktop` (TCC). If a screenshot's `save_to_disk` note, or a `file_upload` reply, contains `EPERM`, the app running the MCP server (your terminal, or the Claude app) doesn't have permission to reach that folder. For `file_upload`, the browser itself (Chrome, Brave, Edge) also reads the file directly, so it needs that same folder access, separately from the terminal or Claude app. It isn't a wrong path. Fix it in **System Settings > Privacy & Security > Files and Folders**: grant the terminal or app, and your browser, access to Downloads (and Desktop, if you use it), then try again.

## License

MIT

Built by [Sebastian Sosa](https://github.com/CakeCrusher) ([Noemica](https://noemica.io))

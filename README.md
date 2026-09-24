<p align="center">
  <img src="extension/icons/icon128.png" width="96" alt="Open Claude in Chrome">
</p>

<h1 align="center">Open Claude in Chrome</h1>

<p align="center">
  <em>Official Claude in Chrome gives you 58 blocked domains and two browsers.<br/>
  <strong>Open Claude in Chrome gives you the whole web.</strong></em>
  <br/>
  <sub>Clean-room reimplementation of Anthropic's browser extension. No blocklist. Any Chromium browser. The full 22-tool surface.</sub>
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
| **Browser support** | Chrome and Edge only | Any Chromium browser (Chrome, Edge, Brave, Arc, Opera, Vivaldi, etc.) |
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

The native host is spawned by the browser and owns the bridge: it listens on a Unix domain socket at `~/.config/open-claude-in-chrome/run/bridge.sock`, inside a directory it creates with mode `0700`. Every MCP server — any number of them, across any number of Claude Code sessions — connects to that socket as a client. Ownership of the directory (yours, not a symlink, not open to other users) replaces the old shared token: any local process able to open the socket is already running as you.

## Installation

### Prerequisites

- **Node.js** v18+
- **Any Chromium browser** (Chrome, Edge, Brave, Arc, Opera, Vivaldi, etc.)
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
./install.sh <chrome-id> <brave-id> <arc-id>
```

### Step 4: Restart your browser

Close **all** windows and reopen. The browser reads native messaging host configs on startup.

### Step 5: Add to Claude Code

```bash
claude mcp add open-claude-in-chrome -- node /absolute/path/to/host/mcp-server.js
```

Find the absolute path with:

```bash
echo "node $(pwd)/host/mcp-server.js"
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
| `computer` | Mouse, keyboard, screenshots (13 actions; `save_to_disk` writes to Downloads) |
| `browser_batch` | Run a sequence of tool calls in one round trip |
| `read_page` | Accessibility tree with element refs |
| `get_page_text` | Extract article/main text |
| `find` | Find elements by text/attributes |
| `form_input` | Set form values by ref |
| `javascript_tool` | Execute JS in page context |
| `read_console_messages` | Console output (filtered) |
| `read_network_requests` | Network activity |
| `resize_window` | Resize browser window |
| `file_upload` | Upload local files to a file input by ref |
| `upload_image` | Upload a captured screenshot to a file input (best-effort) |
| `gif_creator` | GIF recording (stub) |
| `shortcuts_list` | List shortcuts (stub) |
| `shortcuts_execute` | Run shortcut (stub) |
| `switch_browser` | Switch browser (stub) |
| `list_connected_browsers` | List connected browsers (stub) |
| `select_browser` | Select browser by deviceId (stub) |

## Updating After Code Changes

No build step. All files are plain JavaScript. After pulling or editing code:

| What changed | What to do |
|---|---|
| `extension/background.js` or `extension/content.js` or `extension/manifest.json` | Reload the extension: `brave://extensions` > click the reload icon |
| `host/*.js` (`native-host.js`, `mcp-server.js`, `bridge-hub.js`, `bridge-client.js`, `bridge-endpoint.js`) | Restart the browser (new native host), then `pkill -f "node.*open-claude-in-chrome/host/mcp-server"` and `/mcp` in each Claude Code session |
| `install.sh` or native host name changed | Re-run `./install.sh <extension-id>`, restart browser, re-add MCP |

> Old and new versions of the bridge cannot talk to each other, so after changing anything under `host/`, refresh **both** sides: restart the browser (spawns a fresh native host) **and** `pkill` + `/mcp` in every session (spawns fresh MCP servers). Reloading the extension also picks up any new manifest permission (for example `downloads`, used by `save_to_disk`).

### Quick reset (nuclear option)

If things are broken and you're not sure why:

```bash
# 1. Kill all MCP servers
pkill -f "node.*open-claude-in-chrome/host/mcp-server"

# 2. Re-run install
./install.sh <your-extension-id>

# 3. Restart browser (close all windows, reopen)

# 4. Reload extension in brave://extensions

# 5. Reconnect in Claude Code
# /mcp
```

## Multiple Sessions

Any number of Claude Code sessions can share the same browser. Each session's MCP server connects to the native host's bridge as an equal client, none of them owns the link, so one session ending never disconnects the others, and there is no "primary" to promote or lose.

## Troubleshooting

### Extension not connecting

1. Verify the extension is loaded and enabled
2. Check that `./install.sh` was run with the correct extension ID
3. Restart the browser completely (all windows)
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

The MCP server is running but no native host is attached. Check, in order:
1. **Is the browser running?** The extension and its native host only exist while the browser is open — no browser means no connection.
2. Open any webpage to wake the service worker.
3. Reload the extension in `chrome://extensions` — a fresh service worker reconnects the native host to the running server.
4. Check service worker logs: `chrome://extensions` > "Inspect views: service worker".
5. Verify `host/native-host-wrapper.sh` exists and its `node` path is valid.

### Socket permission error

The native host refuses to serve the bridge, and logs the reason, when the directory `~/.config/open-claude-in-chrome/run` is a symlink, not owned by you, or open to other users (anything but mode `0700`). Remove or fix the directory so the native host can recreate it correctly, then restart the browser.

## License

MIT

Built by [Sebastian Sosa](https://github.com/CakeCrusher) ([Noemica](https://noemica.io))

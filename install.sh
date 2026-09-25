#!/bin/bash
set -e

# Install script for Open Claude in Chrome extension.
# Registers the native messaging host for Chrome, Edge, and Brave.
#
# Usage: ./install.sh <extension-id> [extension-id-2] [extension-id-3] ...
#
# Pass one extension ID per browser. Each Chromium browser assigns a different
# ID when loading unpacked extensions, so if you use both Chrome and Brave,
# pass both IDs.

if [ -z "$1" ]; then
  echo "Usage: ./install.sh <extension-id> [extension-id-2] ..."
  echo ""
  echo "Pass one extension ID per browser you want to use."
  echo "Each browser assigns a different ID to the same unpacked extension."
  echo ""
  echo "Steps:"
  echo "  1. Open chrome://extensions (and/or brave://extensions)"
  echo "  2. Enable Developer Mode"
  echo "  3. Click 'Load unpacked' and select the extension/ directory"
  echo "  4. Copy the extension ID shown under the extension name"
  echo "  5. Repeat for each browser"
  echo "  6. Run: ./install.sh <chrome-id> <brave-id>"
  exit 1
fi

EXTENSION_IDS=("$@")
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_DIR="$SCRIPT_DIR/host"
NATIVE_HOST_PATH="$HOST_DIR/native-host-wrapper.sh"
HOST_NAME="com.anthropic.open_claude_in_chrome"

# Verify node is available
if ! command -v node &> /dev/null; then
  echo "Error: node is not installed. Install Node.js first."
  exit 1
fi

# Verify npm dependencies are installed
if [ ! -d "$HOST_DIR/node_modules" ]; then
  echo "Installing npm dependencies..."
  cd "$HOST_DIR" && npm install
  cd "$SCRIPT_DIR"
fi

# Create the native host wrapper script
# Chrome launches this via native messaging — it needs to find node and the script.
cat > "$NATIVE_HOST_PATH" << WRAPPER
#!/bin/sh
exec "$(which node)" "$HOST_DIR/native-host.js"
WRAPPER
chmod +x "$NATIVE_HOST_PATH"

echo "Created native host wrapper: $NATIVE_HOST_PATH"

# Build allowed_origins array from all extension IDs
ORIGINS=""
for i in "${!EXTENSION_IDS[@]}"; do
  if [ $i -gt 0 ]; then ORIGINS="$ORIGINS,"; fi
  ORIGINS="$ORIGINS
    \"chrome-extension://${EXTENSION_IDS[$i]}/\""
done

# Native messaging host manifest
generate_manifest() {
  cat << EOF
{
  "name": "$HOST_NAME",
  "description": "Open Claude in Chrome Native Messaging Host",
  "path": "$NATIVE_HOST_PATH",
  "type": "stdio",
  "allowed_origins": [$ORIGINS
  ]
}
EOF
}

# Platform-specific installation
install_host() {
  local browser_name="$1"
  local host_dir="$2"

  if [ ! -d "$(dirname "$host_dir")" ]; then
    echo "  Skipping $browser_name (not installed)"
    return
  fi

  mkdir -p "$host_dir"
  generate_manifest > "$host_dir/$HOST_NAME.json"
  echo "  Installed for $browser_name: $host_dir/$HOST_NAME.json"
}

echo ""
echo "Installing native messaging host for extension(s): ${EXTENSION_IDS[*]}"
echo ""

case "$(uname)" in
  Darwin)
    install_host "Google Chrome" \
      "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    install_host "Microsoft Edge" \
      "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
    install_host "Brave Browser" \
      "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    ;;
  Linux)
    install_host "Google Chrome" \
      "$HOME/.config/google-chrome/NativeMessagingHosts"
    install_host "Microsoft Edge" \
      "$HOME/.config/microsoft-edge/NativeMessagingHosts"
    install_host "Brave Browser" \
      "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    ;;
  *)
    echo "Error: Unsupported platform $(uname). This script supports macOS and Linux."
    echo "Windows is not supported: the bridge is built on Unix domain sockets and process.getuid(), which Windows doesn't have."
    exit 1
    ;;
esac

# Link the packaged skill into ~/.claude/skills so agents are told the upload
# allowlist, save_to_disk location, audit mode limits and other tool quirks
# without being asked. Only replaces a symlink that already points at this
# exact skill or at another worktree/clone of this same repository. Any other
# file or link there (including a same-named folder in an unrelated repo,
# such as a dotfiles checkout) is left alone. A failure here is reported, not
# fatal, so it can't stop the native messaging setup above from taking effect.

# Prints the absolute path to the shared .git directory for the repository
# containing $1 (the same result for every worktree of one repository), or
# nothing if $1 doesn't exist or isn't inside a git repository.
repo_common_dir() {
  local dir="$1" common
  [ -d "$dir" ] || return 0
  common=$(git -C "$dir" rev-parse --git-common-dir 2>/dev/null) || return 0
  case "$common" in
    /*) printf '%s\n' "$common" ;;
    *) (cd "$dir" && cd "$common" 2>/dev/null && pwd) ;;
  esac
}

echo ""
echo "Linking the agent skill (if you use personal Claude Code skills):"
CLAUDE_SKILLS_DIR="$HOME/.claude/skills"
SKILL_SRC="$SCRIPT_DIR/skills/open-claude-in-chrome"
if [ -d "$CLAUDE_SKILLS_DIR" ]; then
  SKILL_LINK="$CLAUDE_SKILLS_DIR/open-claude-in-chrome"
  if [ -L "$SKILL_LINK" ]; then
    OLD_TARGET=$(readlink "$SKILL_LINK")
    # A relative target (some older installs made one) resolves against the
    # link's own directory, the same way the OS resolves it, not against
    # wherever this script happens to be invoked from.
    case "$OLD_TARGET" in
      /*) OLD_TARGET_ABS="$OLD_TARGET" ;;
      *) OLD_TARGET_ABS="$CLAUDE_SKILLS_DIR/$OLD_TARGET" ;;
    esac
    NEW_COMMON=$(repo_common_dir "$SCRIPT_DIR")
    SAME_REPO=false
    REASON="already points elsewhere"
    if [ "$OLD_TARGET_ABS" = "$SKILL_SRC" ]; then
      SAME_REPO=true
    elif [ -d "$(dirname "$OLD_TARGET_ABS")" ]; then
      OLD_COMMON=$(repo_common_dir "$(dirname "$OLD_TARGET_ABS")")
      if [ -n "$OLD_COMMON" ] && [ "$OLD_COMMON" = "$NEW_COMMON" ]; then
        SAME_REPO=true
      fi
    else
      # Dangling: its directory is gone (e.g. a removed worktree), so git can
      # no longer tell us its repo. Fall back to a structural check instead:
      # every worktree of this repo lives under this same repo's own root.
      REPO_ROOT=$(dirname "$NEW_COMMON")
      case "$OLD_TARGET_ABS" in
        "$REPO_ROOT"|"$REPO_ROOT"/*) SAME_REPO=true ;;
        *) REASON="is dangling and not clearly part of this repository" ;;
      esac
    fi
    if [ "$SAME_REPO" = true ]; then
      ln -sfn "$SKILL_SRC" "$SKILL_LINK" \
        && echo "  Relinked skill: $SKILL_LINK (was -> $OLD_TARGET) -> $SKILL_SRC" \
        || echo "  Could not relink skill at $SKILL_LINK: check permissions on $CLAUDE_SKILLS_DIR."
    else
      echo "  Skipping skill link: $SKILL_LINK $REASON (-> $OLD_TARGET), leaving it alone."
    fi
  elif [ -e "$SKILL_LINK" ]; then
    echo "  Skipping skill link: $SKILL_LINK already exists and was not made by this installer."
  else
    ln -s "$SKILL_SRC" "$SKILL_LINK" \
      && echo "  Linked skill: $SKILL_LINK -> $SKILL_SRC" \
      || echo "  Could not link skill at $SKILL_LINK: check permissions on $CLAUDE_SKILLS_DIR."
  fi
else
  echo "  No $CLAUDE_SKILLS_DIR found, skipping the agent skill link."
fi

echo ""
echo "Done! Next steps:"
echo ""
echo "  1. Restart your browser (close all windows and reopen)"
echo "  2. Add the MCP server to Claude Code:"
echo ""
echo "     claude mcp add open-claude-in-chrome -- node $HOST_DIR/mcp-server.js"
echo ""
echo "  3. Start a new Claude Code session and test:"
echo ""
echo '     Ask Claude: "Navigate to reddit.com and take a screenshot"'
echo ""

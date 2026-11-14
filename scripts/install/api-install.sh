#!/usr/bin/env bash
# Installs Pixlixir's Local API helper on macOS or Linux and registers it with Chrome (ADR-0012). No admin rights.
# Pixlixir Settings > Local API shows this command with your Pixlixir's ID filled in:
#   curl -fsSL https://raw.githubusercontent.com/GreenFuze/Pixlixir/main/scripts/install/api-install.sh | PIXLIXIR_EXTENSION_ID=<id> bash
# Developers: PIXLIXIR_HELPER_FILE = a locally built helper, used instead of the release's.
set -euo pipefail

HOST_NAME="com.greenfuze.pixlixir"
RELEASE="https://github.com/GreenFuze/Pixlixir/releases/latest/download"
OS="$(uname -s)"
ARCH="$(uname -m)"

fail() { echo "Pixlixir helper install stopped: $*" >&2; exit 1; }

# Paragraph: which Pixlixir may start it: only this one
ID="${PIXLIXIR_EXTENSION_ID:-}"
[[ "$ID" =~ ^[a-p]{32}$ ]] || fail "set PIXLIXIR_EXTENSION_ID to your Pixlixir's ID first. Settings > Local API shows the full command."

# Paragraph: where the helper and Chrome's description of it go on this system
case "$ARCH" in arm64|aarch64) GOARCH="arm64" ;; x86_64|amd64) GOARCH="amd64" ;; *) fail "this processor ($ARCH) is not supported." ;; esac
case "$OS" in
  Darwin)
    DIR="$HOME/Library/Application Support/Pixlixir-Helper"; GOOS="darwin"
    HOST_DIRS=("$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" "$HOME/Library/Application Support/Chromium/NativeMessagingHosts" "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts" "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts")
    ;;
  Linux)
    DIR="${XDG_DATA_HOME:-$HOME/.local/share}/pixlixir-helper"; GOOS="linux"
    HOST_DIRS=("$HOME/.config/google-chrome/NativeMessagingHosts" "$HOME/.config/chromium/NativeMessagingHosts" "$HOME/.config/microsoft-edge/NativeMessagingHosts" "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts")
    ;;
  *) fail "this system ($OS) is not supported." ;;
esac
BIN="$DIR/pixlixir-helper"
mkdir -p "$DIR"
pkill -f "^$BIN" 2>/dev/null || true

# Paragraph: the helper: the release's, checked against its published hash, or a local build
if [ -n "${PIXLIXIR_HELPER_FILE:-}" ]; then
  cp "$PIXLIXIR_HELPER_FILE" "$BIN"
else
  command -v curl >/dev/null || fail "curl is not installed."
  if command -v sha256sum >/dev/null; then SHA="sha256sum"; elif command -v shasum >/dev/null; then SHA="shasum -a 256"; else fail "neither sha256sum nor shasum is installed."; fi
  ASSET="pixlixir-helper-$GOOS-$GOARCH"
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  echo "Downloading the Pixlixir helper..."
  curl -fsSL -o "$WORK/$ASSET" "$RELEASE/$ASSET"
  EXPECTED="$(curl -fsSL "$RELEASE/pixlixir-helper-SHA256SUMS.txt" | awk -v a="$ASSET" '$2 == a || $2 == "*"a {print $1}')"
  [ -n "$EXPECTED" ] || fail "the release lists no hash for $ASSET."
  ACTUAL="$($SHA "$WORK/$ASSET" | awk '{print $1}')"
  [ "$ACTUAL" = "$EXPECTED" ] || fail "the download does not match its published hash (got $ACTUAL, expected $EXPECTED)."
  mv "$WORK/$ASSET" "$BIN"
fi
chmod +x "$BIN"
if [ "$OS" = "Darwin" ]; then xattr -d com.apple.quarantine "$BIN" 2>/dev/null || true; fi

# Paragraph: Chrome's description of the helper, in each browser's folder
for d in "${HOST_DIRS[@]}"; do
  mkdir -p "$d"
  printf '{\n  "name": "%s",\n  "description": "Pixlixir Local API helper",\n  "path": "%s",\n  "type": "stdio",\n  "allowed_origins": ["chrome-extension://%s/"]\n}\n' "$HOST_NAME" "$BIN" "$ID" > "$d/$HOST_NAME.json"
done

echo ""
echo "The Pixlixir helper is installed in $DIR for Pixlixir $ID."
echo "In Pixlixir: Settings > Local API, switch it on."

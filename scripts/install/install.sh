#!/usr/bin/env bash
# Installs or updates Pixlixir from its latest GitHub release (macOS and Linux).
# Usage: curl -fsSL https://raw.githubusercontent.com/GreenFuze/Pixlixir/main/scripts/install/install.sh | bash
# Folder: ~/Pixlixir, or the folder in $PIXLIXIR_DIR. Keep it in place: Chrome loads Pixlixir from it.
set -euo pipefail

URL="https://github.com/GreenFuze/Pixlixir/releases/latest/download/pixlixir.zip"
TARGET="${PIXLIXIR_DIR:-$HOME/Pixlixir}"

fail() { echo "Pixlixir install stopped: $*" >&2; exit 1; }

# Paragraph: read the version of a Pixlixir folder, or nothing when the folder holds no Pixlixir
pixlixir_version() {
  local manifest="$1/manifest.json"
  [ -f "$manifest" ] || return 0
  grep -q '"name": *"Pixlixir"' "$manifest" || return 0
  sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$manifest" | head -n 1
}

# Paragraph: the tools this needs
command -v curl >/dev/null || fail "curl is not installed."
command -v unzip >/dev/null || fail "unzip is not installed (for example: sudo apt install unzip)."

# Paragraph: never overwrite a folder that holds something else
BEFORE=""
if [ -d "$TARGET" ]; then
  BEFORE="$(pixlixir_version "$TARGET")"
  if [ -z "$BEFORE" ] && [ -n "$(ls -A "$TARGET")" ]; then
    fail "'$TARGET' already holds other files. Set PIXLIXIR_DIR to another folder and run again."
  fi
fi

# Paragraph: download and unpack into a temporary folder first
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
echo "Downloading Pixlixir..."
curl -fsSL "$URL" -o "$WORK/pixlixir.zip"
unzip -q "$WORK/pixlixir.zip" -d "$WORK/unpacked"
VERSION="$(pixlixir_version "$WORK/unpacked")"
[ -n "$VERSION" ] || fail "the download from $URL holds no Pixlixir manifest."

# Paragraph: replace the folder's contents, keeping the folder itself so Chrome keeps the same extension
mkdir -p "$TARGET"
find "$TARGET" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -R "$WORK/unpacked/." "$TARGET/"
FULL="$(cd "$TARGET" && pwd)"

# Paragraph: tell the user the one step Chrome leaves to them
COPIED=""
if command -v pbcopy >/dev/null; then printf '%s' "$FULL" | pbcopy && COPIED=" (the path is copied)"
elif command -v wl-copy >/dev/null; then printf '%s' "$FULL" | wl-copy && COPIED=" (the path is copied)"
elif command -v xclip >/dev/null; then printf '%s' "$FULL" | xclip -selection clipboard && COPIED=" (the path is copied)"
fi
echo
if [ "$BEFORE" = "$VERSION" ]; then
  echo "Pixlixir $VERSION is already the newest; its files in $FULL were refreshed."
elif [ -n "$BEFORE" ]; then
  echo "Pixlixir updated from $BEFORE to $VERSION in $FULL"
  echo "In chrome://extensions, press the reload arrow on Pixlixir's card, then reload photos.google.com."
else
  echo "Pixlixir $VERSION is in $FULL$COPIED"
  echo "1. Open chrome://extensions and switch on Developer mode (top right)."
  echo "2. Click Load unpacked and choose that folder (on a Mac, Cmd+Shift+G lets you paste the path)."
  echo "3. Open https://photos.google.com and click the Pixlixir chip in the bottom-right corner."
fi

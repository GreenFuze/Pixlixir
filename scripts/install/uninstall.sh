#!/usr/bin/env bash
# Removes Pixlixir's folder from macOS or Linux. Chrome's own Remove button removes the extension and its saved data.
# Usage: curl -fsSL https://raw.githubusercontent.com/GreenFuze/Pixlixir/main/scripts/install/uninstall.sh | bash
# Folder: ~/Pixlixir, or $PIXLIXIR_DIR.
set -euo pipefail

TARGET="${PIXLIXIR_DIR:-$HOME/Pixlixir}"

# Paragraph: only a folder that holds Pixlixir is removed
if [ ! -d "$TARGET" ]; then
  echo "Pixlixir is not installed in $TARGET. Nothing to remove."
else
  grep -q '"name": *"Pixlixir"' "$TARGET/manifest.json" 2>/dev/null || { echo "Pixlixir uninstall stopped: '$TARGET' does not hold Pixlixir, so it is left alone." >&2; exit 1; }
  FULL="$(cd "$TARGET" && pwd)"
  rm -rf "$FULL"
  echo "Removed $FULL"
fi

# Paragraph: the step only Chrome can do
echo "Now open chrome://extensions and press Remove on Pixlixir's card. That also deletes its settings and saved scans."
echo "Local AI installed too? Remove it with: curl -fsSL https://raw.githubusercontent.com/GreenFuze/Pixlixir/main/scripts/install/ai-uninstall.sh | bash"

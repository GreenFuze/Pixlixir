#!/usr/bin/env bash
# Removes Pixlixir's local AI engine from macOS or Linux: stops it, deletes its folder (Python, IOPaint, PyTorch,
# models) and its launcher. Nothing outside those is touched.
# Usage: curl -fsSL https://raw.githubusercontent.com/GreenFuze/Pixlixir/main/scripts/install/ai-uninstall.sh | bash
# Folder: ~/Pixlixir-AI, or $PIXLIXIR_AI_DIR.
set -euo pipefail

DIR="${PIXLIXIR_AI_DIR:-$HOME/Pixlixir-AI}"

# Paragraph: only a folder Pixlixir AI made is removed
if [ ! -d "$DIR" ]; then
  echo "Pixlixir AI is not installed in $DIR. Nothing to remove."
else
  [ -f "$DIR/.pixlixir-ai" ] || { echo "Pixlixir AI uninstall stopped: '$DIR' was not made by Pixlixir AI, so it is left alone." >&2; exit 1; }
  FULL="$(cd "$DIR" && pwd)"

  # Paragraph: stop the engine if it runs from this folder, then remove the folder
  if pkill -f "$FULL/venv/" 2>/dev/null; then sleep 2; fi
  rm -rf "$FULL"
  echo "Removed $FULL"
fi

# Paragraph: and the launcher
for f in "$HOME/Applications/Pixlixir AI.command" "$HOME/.local/share/applications/pixlixir-ai.desktop"; do
  if [ -f "$f" ]; then rm -f "$f"; echo "Removed $f"; fi
done
echo "In Pixlixir: Settings > Local engines, delete its entry with x."

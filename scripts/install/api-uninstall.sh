#!/usr/bin/env bash
# Removes Pixlixir's Local API helper from macOS or Linux: its registrations, then the helper.
# Usage: curl -fsSL https://raw.githubusercontent.com/GreenFuze/Pixlixir/main/scripts/install/api-uninstall.sh | bash
set -euo pipefail

HOST_NAME="com.greenfuze.pixlixir"
case "$(uname -s)" in
  Darwin)
    DIR="$HOME/Library/Application Support/Pixlixir-Helper"
    HOST_DIRS=("$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" "$HOME/Library/Application Support/Chromium/NativeMessagingHosts" "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts" "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts")
    ;;
  *)
    DIR="${XDG_DATA_HOME:-$HOME/.local/share}/pixlixir-helper"
    HOST_DIRS=("$HOME/.config/google-chrome/NativeMessagingHosts" "$HOME/.config/chromium/NativeMessagingHosts" "$HOME/.config/microsoft-edge/NativeMessagingHosts" "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts")
    ;;
esac

# Paragraph: the registrations first, so no browser starts it again
for d in "${HOST_DIRS[@]}"; do
  if [ -f "$d/$HOST_NAME.json" ]; then rm -f "$d/$HOST_NAME.json"; echo "Removed $d/$HOST_NAME.json"; fi
done

# Paragraph: then stop it and remove its folder
pkill -f "^$DIR/pixlixir-helper" 2>/dev/null || true
if [ -d "$DIR" ]; then rm -rf "$DIR"; echo "Removed $DIR"; else echo "The helper's folder $DIR was not there."; fi
echo "In Pixlixir: Settings > Local API shows it as not installed."

#!/usr/bin/env bash
# Installs Pixlixir's local AI engine (IOPaint, for Edit's Erase) on macOS or Linux. Nothing else on the computer
# changes: a private Python, IOPaint, PyTorch and the LaMa model all go into one folder, removed by ai-uninstall.sh.
# Usage: curl -fsSL https://raw.githubusercontent.com/GreenFuze/Pixlixir/main/scripts/install/ai-install.sh | bash
# Folder: ~/Pixlixir-AI, or $PIXLIXIR_AI_DIR. Device: Apple GPU on Apple silicon; NVIDIA GPU on Linux when
# nvidia-smi is found; else CPU. PIXLIXIR_AI_DEVICE=cpu|cuda|mps chooses. Port: 8080, or $PIXLIXIR_AI_PORT.
# PIXLIXIR_AI_NO_START=1 installs without starting it.
set -euo pipefail

# Paragraph: pinned versions, tested together (ADR-0011)
UV_VERSION="0.13.7"
PYTHON="3.11"
TORCH="2.7.1"
TORCHVISION="0.22.1"
PACKAGES=("iopaint==1.6.0" "huggingface_hub==0.25.2")
MARKER=".pixlixir-ai"

DIR="${PIXLIXIR_AI_DIR:-$HOME/Pixlixir-AI}"
PORT="${PIXLIXIR_AI_PORT:-8080}"
OS="$(uname -s)"
ARCH="$(uname -m)"

fail() { echo "Pixlixir AI install stopped: $*" >&2; exit 1; }

# Paragraph: the tools this needs
command -v curl >/dev/null || fail "curl is not installed."
command -v tar >/dev/null || fail "tar is not installed."
if command -v sha256sum >/dev/null; then SHA="sha256sum"; elif command -v shasum >/dev/null; then SHA="shasum -a 256"; else fail "neither sha256sum nor shasum is installed."; fi

# Paragraph: never write into a folder that holds something else
if [ -d "$DIR" ] && [ ! -f "$DIR/$MARKER" ] && [ -n "$(ls -A "$DIR")" ]; then
  fail "'$DIR' already holds other files. Set PIXLIXIR_AI_DIR to another folder and run again."
fi
mkdir -p "$DIR"
echo "Pixlixir AI: this whole folder is removed by ai-uninstall.sh" > "$DIR/$MARKER"

# Paragraph: this computer: uv's build, the device, and where PyTorch comes from
case "$ARCH" in arm64|aarch64) UV_ARCH="aarch64" ;; x86_64|amd64) UV_ARCH="x86_64" ;; *) fail "this processor ($ARCH) is not supported." ;; esac
INDEX=()
case "$OS" in
  Darwin)
    UV_ASSET="uv-$UV_ARCH-apple-darwin.tar.gz"
    if [ "$UV_ARCH" = "aarch64" ]; then DEVICE="${PIXLIXIR_AI_DEVICE:-mps}"; else DEVICE="${PIXLIXIR_AI_DEVICE:-cpu}"; TORCH="2.2.2"; TORCHVISION="0.17.2"; fi
    ;;
  Linux)
    UV_ASSET="uv-$UV_ARCH-unknown-linux-gnu.tar.gz"
    if command -v nvidia-smi >/dev/null; then DEVICE="${PIXLIXIR_AI_DEVICE:-cuda}"; else DEVICE="${PIXLIXIR_AI_DEVICE:-cpu}"; fi
    if [ "$DEVICE" = "cuda" ]; then INDEX=(--index-url https://download.pytorch.org/whl/cu128); else INDEX=(--index-url https://download.pytorch.org/whl/cpu); fi
    ;;
  *) fail "this system ($OS) is not supported." ;;
esac
case "$DEVICE" in cpu|cuda|mps) ;; *) fail "PIXLIXIR_AI_DEVICE must be cpu, cuda or mps, not '$DEVICE'." ;; esac

# Paragraph: uv (Astral's Python manager), checked against its published hash, kept inside the folder
UV="$DIR/bin/uv"
if [ ! -x "$UV" ]; then
  echo "Downloading uv $UV_VERSION..."
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  curl -fsSL -o "$WORK/$UV_ASSET" "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/$UV_ASSET"
  EXPECTED="$(curl -fsSL "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/$UV_ASSET.sha256" | awk '{print $1}')"
  ACTUAL="$($SHA "$WORK/$UV_ASSET" | awk '{print $1}')"
  [ "$ACTUAL" = "$EXPECTED" ] || fail "uv's download does not match its published hash (got $ACTUAL, expected $EXPECTED)."
  tar -xzf "$WORK/$UV_ASSET" -C "$WORK"
  mkdir -p "$DIR/bin"
  find "$WORK" -type f \( -name uv -o -name uvx \) -exec mv {} "$DIR/bin/" \;
fi

# Paragraph: everything uv makes stays in the folder
export UV_PYTHON_INSTALL_DIR="$DIR/python" UV_CACHE_DIR="$DIR/cache" UV_PYTHON_PREFERENCE="only-managed" UV_NO_CONFIG=1
PY="$DIR/venv/bin/python"

# Paragraph: a private Python, PyTorch for the device, then IOPaint
echo "Installing Python $PYTHON, PyTorch $TORCH ($DEVICE) and IOPaint. This downloads up to 3 GB..."
[ -x "$PY" ] || "$UV" venv "$DIR/venv" --python "$PYTHON" --quiet
# IOPaint's dependencies would pull the newest torchvision and with it a newer PyTorch: both are held.
"$UV" pip install --python "$PY" --quiet "torch==$TORCH" "torchvision==$TORCHVISION" ${INDEX[@]+"${INDEX[@]}"}
printf 'torch==%s\ntorchvision==%s\n' "$TORCH" "$TORCHVISION" > "$DIR/constraints.txt"
"$UV" pip install --python "$PY" --quiet "${PACKAGES[@]}" --constraint "$DIR/constraints.txt"

# Paragraph: the start script: models live in the folder too
cat > "$DIR/start.sh" <<EOF
#!/usr/bin/env bash
# Starts Pixlixir AI (IOPaint). Stop it with Ctrl+C or by closing this window.
HERE="\$(cd "\$(dirname "\$0")" && pwd)"
export TORCH_HOME="\$HERE/models/torch" HF_HOME="\$HERE/models/huggingface" XDG_CACHE_HOME="\$HERE/models" TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1
exec "\$HERE/venv/bin/iopaint" start --model=lama --device=$DEVICE --host=127.0.0.1 --port=$PORT
EOF
chmod +x "$DIR/start.sh"

# Paragraph: fetch the LaMa model now, so the first use is quick
echo "Downloading the LaMa model..."
TORCH_HOME="$DIR/models/torch" HF_HOME="$DIR/models/huggingface" XDG_CACHE_HOME="$DIR/models" TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1 "$DIR/venv/bin/iopaint" download --model=lama
"$UV" cache clean --quiet

# Paragraph: something to double-click, then start it now where there is a desktop
STARTED=""
if [ "$OS" = "Darwin" ]; then
  mkdir -p "$HOME/Applications"
  printf '#!/usr/bin/env bash\nexec "%s/start.sh"\n' "$DIR" > "$HOME/Applications/Pixlixir AI.command"
  chmod +x "$HOME/Applications/Pixlixir AI.command"
  LAUNCHER="Pixlixir AI in your Applications folder"
  if [ -z "${PIXLIXIR_AI_NO_START:-}" ]; then open "$HOME/Applications/Pixlixir AI.command" && STARTED=1; fi
else
  mkdir -p "$HOME/.local/share/applications"
  cat > "$HOME/.local/share/applications/pixlixir-ai.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Pixlixir AI
Comment=Starts Pixlixir AI (IOPaint) for Edit in Pixlixir
Exec="$DIR/start.sh"
Terminal=true
Categories=Graphics;
EOF
  LAUNCHER="Pixlixir AI in your applications menu"
  if [ -z "${PIXLIXIR_AI_NO_START:-}" ] && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; } && command -v gtk-launch >/dev/null; then gtk-launch pixlixir-ai >/dev/null 2>&1 && STARTED=1 || true; fi
fi

echo ""
if [ -n "$STARTED" ]; then echo "Pixlixir AI is installed in $DIR and starting at http://127.0.0.1:$PORT ($DEVICE)."; else echo "Pixlixir AI is installed in $DIR ($DEVICE). Start it with: $DIR/start.sh"; fi
echo "Next time, open $LAUNCHER. Close its window to stop it."
echo "In Pixlixir: Settings > Local engines > Add, then choose it in Edit."

# Installs Pixlixir's local AI engine (IOPaint, for Edit's Erase) on Windows. Nothing else on the computer changes:
# a private Python, IOPaint, PyTorch and the LaMa model all go into one folder, removed by ai-uninstall.ps1.
# Usage: irm https://raw.githubusercontent.com/GreenFuze/Pixlixir/main/scripts/install/ai-install.ps1 | iex
# Folder: $HOME\Pixlixir-AI, or $env:PIXLIXIR_AI_DIR. Device: NVIDIA GPU when nvidia-smi is found, else CPU;
# $env:PIXLIXIR_AI_DEVICE = 'cpu' or 'cuda' chooses. Port: 8080, or $env:PIXLIXIR_AI_PORT.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  # Paragraph: pinned versions, tested together (ADR-0011)
  $UvVersion = '0.13.7'
  $Python = '3.11'
  $Torch = '2.7.1'
  $TorchVision = '0.22.1'
  $Packages = @('iopaint==1.6.0', 'huggingface_hub==0.25.2')
  $Marker = '.pixlixir-ai'

  $dir = if ($env:PIXLIXIR_AI_DIR) { $env:PIXLIXIR_AI_DIR } else { Join-Path $HOME 'Pixlixir-AI' }
  $port = if ($env:PIXLIXIR_AI_PORT) { [int]$env:PIXLIXIR_AI_PORT } else { 8080 }
  $shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Pixlixir AI.lnk'

  function Fail([string]$why) { throw "Pixlixir AI install stopped: $why" }

  # Paragraph: never write into a folder that holds something else
  if (Test-Path $dir) {
    $ours = Test-Path (Join-Path $dir $Marker)
    $isEmpty = -not (Get-ChildItem $dir -Force | Select-Object -First 1)
    if (-not $ours -and -not $isEmpty) { Fail "'$dir' already holds other files. Set `$env:PIXLIXIR_AI_DIR to another folder and run again." }
  }
  New-Item -ItemType Directory -Force $dir | Out-Null
  Set-Content -Path (Join-Path $dir $Marker) -Value 'Pixlixir AI: this whole folder is removed by ai-uninstall.ps1'

  # Paragraph: the device: an NVIDIA GPU, or the CPU
  $device = $env:PIXLIXIR_AI_DEVICE
  if (-not $device) { $device = if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { 'cuda' } else { 'cpu' } }
  if ($device -notin @('cuda', 'cpu')) { Fail "PIXLIXIR_AI_DEVICE must be 'cuda' or 'cpu', not '$device'." }
  $torchIndex = if ($device -eq 'cuda') { 'https://download.pytorch.org/whl/cu128' } else { 'https://download.pytorch.org/whl/cpu' }

  # Paragraph: uv (Astral's Python manager), checked against its published hash, kept inside the folder
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x86_64' }
  $asset = "uv-$arch-pc-windows-msvc.zip"
  $bin = Join-Path $dir 'bin'
  $uv = Join-Path $bin 'uv.exe'
  if (-not (Test-Path $uv)) {
    Write-Host "Downloading uv $UvVersion..."
    $work = Join-Path ([IO.Path]::GetTempPath()) ("pixlixir-ai-" + [guid]::NewGuid())
    New-Item -ItemType Directory $work | Out-Null
    try {
      $zip = Join-Path $work $asset
      Invoke-WebRequest -Uri "https://github.com/astral-sh/uv/releases/download/$UvVersion/$asset" -OutFile $zip -UseBasicParsing
      $raw = (Invoke-WebRequest -Uri "https://github.com/astral-sh/uv/releases/download/$UvVersion/$asset.sha256" -UseBasicParsing).Content
      if ($raw -is [byte[]]) { $raw = [Text.Encoding]::ASCII.GetString($raw) }
      $expected = ($raw.Trim() -split '\s+')[0].ToLower()
      $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
      if ($actual -ne $expected) { Fail "uv's download does not match its published hash (got $actual, expected $expected)." }
      Expand-Archive -Path $zip -DestinationPath $work\uv
      New-Item -ItemType Directory -Force $bin | Out-Null
      Get-ChildItem $work\uv -Recurse -Filter 'uv*.exe' | Move-Item -Destination $bin -Force
    } finally {
      Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  # Paragraph: everything uv makes stays in the folder
  $env:UV_PYTHON_INSTALL_DIR = Join-Path $dir 'python'
  $env:UV_CACHE_DIR = Join-Path $dir 'cache'
  $env:UV_PYTHON_PREFERENCE = 'only-managed'
  $env:UV_NO_CONFIG = '1'
  $venv = Join-Path $dir 'venv'
  $py = Join-Path $venv 'Scripts\python.exe'
  function Uv { & $uv @args; if ($LASTEXITCODE -ne 0) { Fail "uv $($args -join ' ') failed (exit $LASTEXITCODE)." } }

  # Paragraph: a private Python, PyTorch for the device, then IOPaint
  Write-Host "Installing Python $Python, PyTorch $Torch ($device) and IOPaint. This downloads up to 3 GB..."
  if (-not (Test-Path $py)) { Uv venv $venv --python $Python --quiet }
  # IOPaint's dependencies would pull the newest torchvision and with it a newer PyTorch: both are held.
  Uv pip install --python $py --quiet "torch==$Torch" "torchvision==$TorchVision" --index-url $torchIndex
  $constraints = Join-Path $dir 'constraints.txt'
  Set-Content -Path $constraints -Value "torch==$Torch`ntorchvision==$TorchVision" -Encoding ASCII
  Uv pip install --python $py --quiet @Packages --constraint $constraints

  # Paragraph: the start script: models live in the folder too
  $start = Join-Path $dir 'start.cmd'
  @(
    '@echo off',
    'title Pixlixir AI (IOPaint) - close this window to stop it',
    'set "TORCH_HOME=%~dp0models\torch"',
    'set "HF_HOME=%~dp0models\huggingface"',
    'set "XDG_CACHE_HOME=%~dp0models"',
    'set "TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1"',
    "`"%~dp0venv\Scripts\iopaint.exe`" start --model=lama --device=$device --host=127.0.0.1 --port=$port",
    'if errorlevel 1 pause'
  ) | Set-Content -Path $start -Encoding ASCII

  # Paragraph: fetch the LaMa model now, so the first use is quick
  Write-Host "Downloading the LaMa model..."
  $env:TORCH_HOME = Join-Path $dir 'models\torch'
  $env:HF_HOME = Join-Path $dir 'models\huggingface'
  $env:XDG_CACHE_HOME = Join-Path $dir 'models'
  $env:TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD = '1'
  & (Join-Path $venv 'Scripts\iopaint.exe') download --model=lama
  if ($LASTEXITCODE -ne 0) { Fail "downloading the LaMa model failed (exit $LASTEXITCODE)." }
  Uv cache clean --quiet

  # Paragraph: a Start menu entry, then start it now
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($shortcut)
  $link.TargetPath = $start
  $link.WorkingDirectory = $dir
  $link.Description = 'Starts Pixlixir AI (IOPaint) for Edit in Pixlixir'
  $link.Save()
  Start-Process -FilePath $start -WorkingDirectory $dir

  Write-Host ""
  Write-Host "Pixlixir AI is installed in $dir and starting at http://127.0.0.1:$port ($device)." -ForegroundColor Green
  Write-Host "Next time, open 'Pixlixir AI' from the Start menu. Close its window to stop it."
  Write-Host "In Pixlixir: Settings > Local engines > Add, then choose it in Edit."
}

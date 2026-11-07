# Installs or updates Pixlixir from its latest GitHub release (Windows PowerShell 5.1 or PowerShell 7).
# Usage: irm https://raw.githubusercontent.com/GreenFuze/Pixlixir/main/scripts/install/install.ps1 | iex
# Folder: $HOME\Pixlixir, or the folder in $env:PIXLIXIR_DIR. Keep it in place: Chrome loads Pixlixir from it.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $url = 'https://github.com/GreenFuze/Pixlixir/releases/latest/download/pixlixir.zip'
  $target = if ($env:PIXLIXIR_DIR) { $env:PIXLIXIR_DIR } else { Join-Path $HOME 'Pixlixir' }

  # Paragraph: read the version of a Pixlixir folder, or $null when the folder holds no Pixlixir
  function Get-PixlixirVersion([string]$folder) {
    $manifest = Join-Path $folder 'manifest.json'
    if (-not (Test-Path $manifest)) { return $null }
    $json = Get-Content $manifest -Raw | ConvertFrom-Json
    if ($json.name -ne 'Pixlixir') { return $null }
    return $json.version
  }

  # Paragraph: never overwrite a folder that holds something else
  $before = $null
  if (Test-Path $target) {
    $before = Get-PixlixirVersion $target
    $isEmpty = -not (Get-ChildItem $target -Force | Select-Object -First 1)
    if (-not $before -and -not $isEmpty) {
      throw "Pixlixir install stopped: '$target' already holds other files. Set `$env:PIXLIXIR_DIR to another folder and run again."
    }
  }

  # Paragraph: download and unpack into a temporary folder first
  $work = Join-Path ([IO.Path]::GetTempPath()) ("pixlixir-" + [guid]::NewGuid())
  New-Item -ItemType Directory $work | Out-Null
  try {
    Write-Host "Downloading Pixlixir..."
    $zip = Join-Path $work 'pixlixir.zip'
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    $unpacked = Join-Path $work 'unpacked'
    Expand-Archive -Path $zip -DestinationPath $unpacked
    $version = Get-PixlixirVersion $unpacked
    if (-not $version) { throw "Pixlixir install stopped: the download from $url holds no Pixlixir manifest." }

    # Paragraph: replace the folder's contents, keeping the folder itself so Chrome keeps the same extension
    New-Item -ItemType Directory -Force $target | Out-Null
    Get-ChildItem $target -Force | Remove-Item -Recurse -Force
    Get-ChildItem $unpacked -Force | Move-Item -Destination $target
  } finally {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
  }

  # Paragraph: tell the user the one step Chrome leaves to them
  $full = (Resolve-Path $target).Path
  Set-Clipboard -Value $full
  Write-Host ""
  if ($before -eq $version) {
    Write-Host "Pixlixir $version is already the newest; its files in $full were refreshed." -ForegroundColor Green
  } elseif ($before) {
    Write-Host "Pixlixir updated from $before to $version in $full" -ForegroundColor Green
    Write-Host "In chrome://extensions, press the reload arrow on Pixlixir's card, then reload photos.google.com."
  } else {
    Write-Host "Pixlixir $version is in $full (the path is copied)" -ForegroundColor Green
    Write-Host "1. Open chrome://extensions and switch on Developer mode (top right)."
    Write-Host "2. Click Load unpacked, paste the path into the folder box and choose Select Folder."
    Write-Host "3. Open https://photos.google.com and click the Pixlixir chip in the bottom-right corner."
  }
}

# Installs Pixlixir's Local API helper on Windows and registers it with Chrome (ADR-0012). No admin rights:
# the helper goes to %LOCALAPPDATA%\Pixlixir-Helper and Chrome learns of it from a per-user registry key.
# Pixlixir Settings > Local API shows this command with your Pixlixir's ID filled in:
#   $env:PIXLIXIR_EXTENSION_ID='<id>'; irm https://raw.githubusercontent.com/GreenFuze/Pixlixir/main/scripts/install/api-install.ps1 | iex
# Developers: $env:PIXLIXIR_HELPER_FILE = a locally built helper, used instead of the release's.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $Host_ = 'com.greenfuze.pixlixir'
  $Release = 'https://github.com/GreenFuze/Pixlixir/releases/latest/download'
  $dir = Join-Path $env:LOCALAPPDATA 'Pixlixir-Helper'
  $exe = Join-Path $dir 'pixlixir-helper.exe'
  $manifest = Join-Path $dir "$Host_.json"
  $browsers = @('Google\Chrome', 'Chromium', 'Microsoft\Edge', 'BraveSoftware\Brave-Browser')

  function Fail([string]$why) { throw "Pixlixir helper install stopped: $why" }

  # Paragraph: which Pixlixir may start it: only this one
  $id = $env:PIXLIXIR_EXTENSION_ID
  if (-not $id -or $id -notmatch '^[a-p]{32}$') { Fail "set PIXLIXIR_EXTENSION_ID to your Pixlixir's ID first. Settings > Local API shows the full command." }

  # Paragraph: stop a running helper so its file can be replaced
  New-Item -ItemType Directory -Force $dir | Out-Null
  Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $exe } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

  # Paragraph: the helper: the release's, checked against its published hash, or a local build
  if ($env:PIXLIXIR_HELPER_FILE) {
    Copy-Item $env:PIXLIXIR_HELPER_FILE $exe -Force
  } else {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
    $asset = "pixlixir-helper-windows-$arch.exe"
    $work = Join-Path ([IO.Path]::GetTempPath()) ("pixlixir-helper-" + [guid]::NewGuid())
    New-Item -ItemType Directory $work | Out-Null
    try {
      Write-Host "Downloading the Pixlixir helper..."
      Invoke-WebRequest -Uri "$Release/$asset" -OutFile (Join-Path $work $asset) -UseBasicParsing
      $sums = (Invoke-WebRequest -Uri "$Release/pixlixir-helper-SHA256SUMS.txt" -UseBasicParsing).Content
      if ($sums -is [byte[]]) { $sums = [Text.Encoding]::ASCII.GetString($sums) }
      $line = ($sums -split "`n") | Where-Object { $_ -match "\s\*?$([regex]::Escape($asset))\s*$" } | Select-Object -First 1
      if (-not $line) { Fail "the release lists no hash for $asset." }
      $expected = ($line.Trim() -split '\s+')[0].ToLower()
      $actual = (Get-FileHash (Join-Path $work $asset) -Algorithm SHA256).Hash.ToLower()
      if ($actual -ne $expected) { Fail "the download does not match its published hash (got $actual, expected $expected)." }
      Move-Item (Join-Path $work $asset) $exe -Force
    } finally {
      Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  # Paragraph: Chrome's description of the helper, and the per-user keys that point to it
  # (written without a byte-order mark, which Windows PowerShell's UTF8 would add)
  $json = [ordered]@{ name = $Host_; description = 'Pixlixir Local API helper'; path = $exe; type = 'stdio'; allowed_origins = @("chrome-extension://$id/") } | ConvertTo-Json
  [IO.File]::WriteAllText($manifest, $json, (New-Object Text.UTF8Encoding($false)))
  foreach ($b in $browsers) {
    $key = "HKCU:\Software\$b\NativeMessagingHosts\$Host_"
    New-Item -Path $key -Force | Out-Null
    Set-Item -Path $key -Value $manifest
  }

  Write-Host ""
  Write-Host "The Pixlixir helper is installed in $dir for Pixlixir $id." -ForegroundColor Green
  Write-Host "In Pixlixir: Settings > Local API, switch it on."
}

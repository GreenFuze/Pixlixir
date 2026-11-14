# Removes Pixlixir's Local API helper from Windows: stops it, deletes its folder and its registry keys.
# Usage: irm https://raw.githubusercontent.com/GreenFuze/Pixlixir/main/scripts/install/api-uninstall.ps1 | iex
& {
  $ErrorActionPreference = 'Stop'
  $Host_ = 'com.greenfuze.pixlixir'
  $dir = Join-Path $env:LOCALAPPDATA 'Pixlixir-Helper'
  $exe = Join-Path $dir 'pixlixir-helper.exe'

  # Paragraph: Chrome's keys first, so no browser starts it again
  foreach ($b in @('Google\Chrome', 'Chromium', 'Microsoft\Edge', 'BraveSoftware\Brave-Browser')) {
    $key = "HKCU:\Software\$b\NativeMessagingHosts\$Host_"
    if (Test-Path $key) { Remove-Item $key -Force; Write-Host "Removed the $b registration." }
  }

  # Paragraph: then stop it and remove its folder
  Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $exe } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  if (Test-Path $dir) {
    Start-Sleep -Milliseconds 500
    Remove-Item $dir -Recurse -Force
    Write-Host "Removed $dir" -ForegroundColor Green
  } else {
    Write-Host "The helper's folder $dir was not there."
  }
  Write-Host "In Pixlixir: Settings > Local API shows it as not installed."
}

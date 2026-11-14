# Removes Pixlixir's local AI engine from Windows: stops it, deletes its folder (Python, IOPaint, PyTorch, models)
# and its Start menu entry. Nothing outside those is touched.
# Usage: irm https://raw.githubusercontent.com/GreenFuze/Pixlixir/main/scripts/install/ai-uninstall.ps1 | iex
# Folder: $HOME\Pixlixir-AI, or $env:PIXLIXIR_AI_DIR.
& {
  $ErrorActionPreference = 'Stop'
  $dir = if ($env:PIXLIXIR_AI_DIR) { $env:PIXLIXIR_AI_DIR } else { Join-Path $HOME 'Pixlixir-AI' }
  $shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Pixlixir AI.lnk'

  # Paragraph: only a folder Pixlixir AI made is removed
  if (-not (Test-Path $dir)) {
    Write-Host "Pixlixir AI is not installed in $dir. Nothing to remove."
  } else {
    if (-not (Test-Path (Join-Path $dir '.pixlixir-ai'))) { throw "Pixlixir AI uninstall stopped: '$dir' was not made by Pixlixir AI, so it is left alone." }
    $full = (Resolve-Path $dir).Path

    # Paragraph: stop the engine if it runs from this folder
    # (its own programs, and the window that runs start.cmd)
    $running = Get-CimInstance Win32_Process | Where-Object { ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($full, [StringComparison]::OrdinalIgnoreCase)) -or ($_.Name -eq 'cmd.exe' -and $_.CommandLine -and $_.CommandLine.IndexOf((Join-Path $full 'start.cmd'), [StringComparison]::OrdinalIgnoreCase) -ge 0) }
    foreach ($p in $running) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    if ($running) { Start-Sleep -Seconds 2 }

    # Paragraph: then the folder
    Remove-Item $full -Recurse -Force
    Write-Host "Removed $full" -ForegroundColor Green
  }

  # Paragraph: and the Start menu entry
  if (Test-Path $shortcut) { Remove-Item $shortcut -Force; Write-Host "Removed the Start menu entry." }
  Write-Host "In Pixlixir: Settings > Local engines, delete its entry with x."
}

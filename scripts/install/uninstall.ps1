# Removes Pixlixir's folder from Windows. Chrome's own Remove button removes the extension and its saved data.
# Usage: irm https://raw.githubusercontent.com/GreenFuze/Pixlixir/main/scripts/install/uninstall.ps1 | iex
# Folder: $HOME\Pixlixir, or $env:PIXLIXIR_DIR.
& {
  $ErrorActionPreference = 'Stop'
  $target = if ($env:PIXLIXIR_DIR) { $env:PIXLIXIR_DIR } else { Join-Path $HOME 'Pixlixir' }

  # Paragraph: only a folder that holds Pixlixir is removed
  if (-not (Test-Path $target)) {
    Write-Host "Pixlixir is not installed in $target. Nothing to remove."
  } else {
    $manifest = Join-Path $target 'manifest.json'
    if (-not (Test-Path $manifest) -or (Get-Content $manifest -Raw | ConvertFrom-Json).name -ne 'Pixlixir') {
      throw "Pixlixir uninstall stopped: '$target' does not hold Pixlixir, so it is left alone."
    }
    $full = (Resolve-Path $target).Path
    Remove-Item $full -Recurse -Force
    Write-Host "Removed $full" -ForegroundColor Green
  }

  # Paragraph: the step only Chrome can do
  Write-Host "Now open chrome://extensions and press Remove on Pixlixir's card. That also deletes its settings and saved scans."
  Write-Host "Local AI installed too? Remove it with: irm https://raw.githubusercontent.com/GreenFuze/Pixlixir/main/scripts/install/ai-uninstall.ps1 | iex"
}

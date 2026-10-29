# Moonstone - Windows uninstaller.
#
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 [-Purge]
#   irm https://raw.githubusercontent.com/nicedreamzapp/moonstone/main/uninstall.ps1 | iex
#
# Stops the Moonstone server that runs from this install, removes the "Moonstone" and
# "Moonstone Autoupdate" tasks (or the Startup shortcut) and the hidden launchers. The install
# folder with your config.json and chat history is kept unless you pass -Purge (or MOONSTONE_PURGE=1).
# Same settings as install.ps1: -Dir/MOONSTONE_DIR, -TaskName/MOONSTONE_TASK.

function Uninstall-Moonstone {
  param(
    [string]$Dir = $(if ($env:MOONSTONE_DIR) { $env:MOONSTONE_DIR } else { Join-Path $env:USERPROFILE "moonstone" }),
    [string]$TaskName = $(if ($env:MOONSTONE_TASK) { $env:MOONSTONE_TASK } else { "Moonstone" }),
    [switch]$Purge = ($env:MOONSTONE_PURGE -eq "1")
  )
  $ErrorActionPreference = "Continue"
  Write-Host "== Moonstone - uninstall =="

  foreach ($t in @($TaskName, "$TaskName Autoupdate")) {
    if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $t -Confirm:$false
      Write-Host "-> Removed task '$t'"
    }
  }
  # Only processes, shortcuts and files from THIS install: the wscript loop first so it can't restart node.
  $runVbs = Join-Path $Dir "moonstone-run.vbs"
  $lnk = Join-Path ([Environment]::GetFolderPath("Startup")) "$TaskName.lnk"
  if ((Test-Path $lnk) -and (New-Object -ComObject WScript.Shell).CreateShortcut($lnk).Arguments.IndexOf($runVbs, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
    Remove-Item $lnk -Force; Write-Host "-> Removed $lnk"
  }
  $server = Join-Path $Dir "server.js"
  $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine }
  $loops = @($procs | Where-Object { $_.Name -eq "wscript.exe" -and $_.CommandLine.IndexOf($runVbs, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
  $loops | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  $nodes = @($procs | Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine.IndexOf($server, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
  $nodes | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($loops.Count + $nodes.Count) { Write-Host "-> Stopped Moonstone ($($nodes.Count) server, $($loops.Count) launcher)" }

  foreach ($f in "moonstone-run.vbs", "moonstone-update.vbs", "moonstone-restart.ps1") { Remove-Item (Join-Path $Dir $f) -Force -ErrorAction SilentlyContinue }

  if ($Purge) {
    Start-Sleep -Seconds 1
    if (Test-Path $Dir) { Remove-Item $Dir -Recurse -Force; Write-Host "-> Deleted $Dir" }
  } else {
    Write-Host "-> Kept $Dir (config.json, history). Run with -Purge to delete it."
  }
  Write-Host "Done."
}

Uninstall-Moonstone @args

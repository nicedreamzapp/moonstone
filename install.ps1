# Moonstone - Windows installer.
#
#   irm https://raw.githubusercontent.com/nicedreamzapp/moonstone/main/install.ps1 | iex
#
# or, from a checkout:  powershell -ExecutionPolicy Bypass -File install.ps1 [-Dir C:\moonstone] [-Port 8899] [-NoStart]
#
# Checks for Node 18+, clones (or updates) Moonstone, writes a starter config.json if there is
# none, and registers two Task Scheduler tasks that run with no console window:
#   "Moonstone"            starts node server.js at logon and restarts it if it exits
#   "Moonstone Autoupdate" runs node updater.js every 5 minutes (it only updates when nothing is busy)
# If Task Scheduler refuses (some locked-down PCs), a shortcut in your Startup folder is used instead.
#
# Settings (params when run from a file, env vars when piped into iex):
#   -Dir      / MOONSTONE_DIR        install folder     (default %USERPROFILE%\moonstone)
#   -Port     / DOCK_PORT            port               (default 8899)
#   -TaskName / MOONSTONE_TASK       task name prefix   (default Moonstone)
#   -NoStart  / MOONSTONE_NO_START=1 set it up but don't start it now
#   -NoUpdater / MOONSTONE_NO_UPDATER=1  skip the autoupdate task

function Install-Moonstone {
  param(
    [string]$Dir = $(if ($env:MOONSTONE_DIR) { $env:MOONSTONE_DIR } else { Join-Path $env:USERPROFILE "moonstone" }),
    [int]$Port = $(if ($env:DOCK_PORT) { [int]$env:DOCK_PORT } else { 8899 }),
    [string]$TaskName = $(if ($env:MOONSTONE_TASK) { $env:MOONSTONE_TASK } else { "Moonstone" }),
    [switch]$NoStart = ($env:MOONSTONE_NO_START -eq "1"),
    [switch]$NoUpdater = ($env:MOONSTONE_NO_UPDATER -eq "1")
  )
  $ErrorActionPreference = "Stop"
  $Repo = "https://github.com/nicedreamzapp/moonstone"

  Write-Host ""
  Write-Host "== Moonstone - Windows installer =="
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw "Node.js not found. Install Node 18 or newer: winget install OpenJS.NodeJS.LTS (or https://nodejs.org)" }
  $major = [int](((& $node.Source -v) -replace '^v', '').Split('.')[0])
  if ($major -lt 18) { throw "Node $(& $node.Source -v) is too old; Moonstone needs Node 18 or newer." }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "git not found. Install Git for Windows from https://git-scm.com/download/win" }
  Write-Host "-> Node $(& $node.Source -v) at $($node.Source)"
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Host "   Note: Claude Code CLI not found on PATH. Moonstone runs, but install Claude Code to start chats."
  }

  if (Test-Path (Join-Path $Dir ".git")) {
    Write-Host "-> Updating $Dir"
    git -C $Dir pull --ff-only --quiet
    if ($LASTEXITCODE -ne 0) { Write-Host "   (local changes kept, skipping the pull)" }
  } elseif (Test-Path $Dir) {
    throw "$Dir exists and is not a git checkout. Move it aside or pass -Dir / set MOONSTONE_DIR."
  } else {
    Write-Host "-> Cloning into $Dir"
    git clone --quiet $Repo $Dir
    if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
  }

  # Starter config: this machine, one Claude Code launcher, and an autoupdate restart that kills
  # only this install's server (the launcher loop below brings it straight back).
  $cfg = Join-Path $Dir "config.json"
  $server = Join-Path $Dir "server.js"
  $restart = Join-Path $Dir "moonstone-restart.ps1"
  Set-Content -Path $restart -Encoding ASCII -Value @(
    "# Stops this install's node server.js; the hidden launcher loop starts it again (autoupdate.restart).",
    "Get-CimInstance Win32_Process | Where-Object { `$_.Name -eq 'node.exe' -and `$_.CommandLine -like '*$server*' } | ForEach-Object { Stop-Process -Id `$_.ProcessId -Force }"
  )
  if (-not (Test-Path $cfg)) {
    $id = ($env:COMPUTERNAME.ToLower() -replace '[^a-z0-9]', '')
    $obj = [ordered]@{
      machine    = $id
      name       = $env:COMPUTERNAME
      peers      = @()
      launchers  = @([ordered]@{ label = "Claude Code"; group = "main"; cwd = "~"; mode = "default" })
      autoupdate = [ordered]@{ branch = "main"; port = $Port; restart = @("powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $restart) }
    }
    [IO.File]::WriteAllText($cfg, ($obj | ConvertTo-Json -Depth 6))
    Write-Host "-> Wrote a starter config.json (edit launchers and peers there)"
  } else {
    Write-Host "-> Kept your config.json"
  }

  # Hidden launchers (wscript, window style 0): nothing flashes on screen.
  $nodeExe = $node.Source
  $runVbs = Join-Path $Dir "moonstone-run.vbs"
  Set-Content -Path $runVbs -Encoding ASCII -Value @(
    "' Runs Moonstone with no console window and restarts it if it exits (task ""$TaskName"").",
    "Set sh = CreateObject(""WScript.Shell"")",
    "sh.Environment(""Process"")(""DOCK_PORT"") = ""$Port""",
    "sh.CurrentDirectory = ""$Dir""",
    "Do",
    "  sh.Run """"""$nodeExe"""" """"$server"""""", 0, True",
    "  WScript.Sleep 5000",
    "Loop"
  )
  $updVbs = Join-Path $Dir "moonstone-update.vbs"
  Set-Content -Path $updVbs -Encoding ASCII -Value @(
    "' Runs Moonstone's updater once with no console window (task ""$TaskName Autoupdate"").",
    "Set sh = CreateObject(""WScript.Shell"")",
    "sh.Environment(""Process"")(""DOCK_PORT"") = ""$Port""",
    "sh.CurrentDirectory = ""$Dir""",
    "sh.Run """"""$nodeExe"""" """"$(Join-Path $Dir 'updater.js')"""""", 0, True"
  )

  $user = "$env:USERDOMAIN\$env:USERNAME"
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  $viaTask = $true
  try {
    Register-ScheduledTask -TaskName $TaskName -Principal $principal -Settings $settings -Force `
      -Action (New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$runVbs`"") `
      -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $user) | Out-Null
    Write-Host "-> Task '$TaskName' registered (starts at logon)"
    if (-not $NoUpdater) {
      $every = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5)
      $usettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
      Register-ScheduledTask -TaskName "$TaskName Autoupdate" -Principal $principal -Settings $usettings -Force `
        -Action (New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$updVbs`"") -Trigger $every | Out-Null
      Write-Host "-> Task '$TaskName Autoupdate' registered (every 5 minutes)"
    }
  } catch {
    $viaTask = $false
    $startup = [Environment]::GetFolderPath("Startup")
    $lnk = Join-Path $startup "$TaskName.lnk"
    $ws = New-Object -ComObject WScript.Shell
    $s = $ws.CreateShortcut($lnk); $s.TargetPath = "wscript.exe"; $s.Arguments = "`"$runVbs`""; $s.WorkingDirectory = $Dir; $s.Save()
    Write-Host "-> Task Scheduler said no ($($_.Exception.Message)); added a Startup shortcut instead: $lnk"
  }

  if ($NoStart) {
    Write-Host "-> Not started now (-NoStart). It starts at your next logon."
  } else {
    $up = $false
    try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$Port/" | Out-Null; $up = $true } catch { }
    if ($up) {
      Write-Host "-> Something already answers on port $Port; not starting a second copy."
    } else {
      if ($viaTask) { Start-ScheduledTask -TaskName $TaskName } else { Start-Process wscript.exe -ArgumentList "`"$runVbs`"" }
      for ($i = 0; $i -lt 30 -and -not $up; $i++) {
        Start-Sleep -Seconds 1
        try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$Port/" | Out-Null; $up = $true } catch { }
      }
      if ($up) { Write-Host "-> Moonstone is up" } else { Write-Host "-> Moonstone did not answer on $Port yet" }
    }
  }
  Write-Host ""
  Write-Host "Done. Open http://localhost:$Port"
  Write-Host "Uninstall: powershell -ExecutionPolicy Bypass -File `"$(Join-Path $Dir 'uninstall.ps1')`""
}

Install-Moonstone @args

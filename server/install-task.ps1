# Registers the bot as a Windows task that starts with the server (as SYSTEM, no login needed)
# and starts it now. Run once in an admin PowerShell from the bot folder.
$root = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Force (Join-Path $root "data") | Out-Null
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$root\server\run.cmd`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "DownloaderBot" -Action $action -Trigger $trigger -Settings $settings -User "SYSTEM" -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName "DownloaderBot"
Write-Host "DownloaderBot task registered and started. Log: $root\data\bot.log"

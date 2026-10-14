Stop-ScheduledTask -TaskName DownloaderBot
Get-Process node, cmd -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*nodejs*' -or $_.CommandLine -like '*run.cmd*' } | Stop-Process -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*bot.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep 2
Start-ScheduledTask -TaskName DownloaderBot
Start-Sleep 6
"node processes running bot.mjs: " + @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*bot.mjs*' }).Count
Get-Content C:\bot\data\bot.log -Tail 2

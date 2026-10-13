# Copy the bot token from @BotFather, then run this. It writes BOT_TOKEN to .env from the clipboard
# without showing it on screen.
$token = (Get-Clipboard).Trim()
if ($token -notmatch '^\d+:[\w-]{30,}$') { Write-Host "The clipboard doesn't look like a bot token. Copy it from @BotFather and try again."; exit 1 }
Set-Content -Path (Join-Path $PSScriptRoot ".env") -Value "BOT_TOKEN=$token" -Encoding utf8
Write-Host "Saved to .env. Now run start.bat."

# Connects the Cloudflare Worker and this PC to your Telegram bot. Copy the token from @BotFather, then run this
# (right-click -> Run with PowerShell). The token goes from the clipboard straight to Cloudflare and to ..\.env;
# it isn't shown on screen, and the clipboard is cleared at the end.
Set-Location $PSScriptRoot
$token = (Get-Clipboard).Trim()
if ($token -notmatch '^\d+:[\w-]{30,}$') { Write-Host "The clipboard doesn't look like a bot token. Copy it from @BotFather and try again."; pause; exit 1 }

function New-Secret { -join ((48..57) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ }) }
$webhookSecret = New-Secret
$pcKey = New-Secret

$token         | npx wrangler secret put BOT_TOKEN
$webhookSecret | npx wrangler secret put WEBHOOK_SECRET
$pcKey         | npx wrangler secret put PC_KEY

# The PC half (pc_worker.py) uploads YouTube/SoundCloud files itself, so it needs the token and the PC key too.
Set-Content -Path (Join-Path $PSScriptRoot "..\.env") -Value @("BOT_TOKEN=$token", "PC_KEY=$pcKey") -Encoding utf8

$hook = "https://tiktok-bot.didigotreizoo.workers.dev/webhook"
$r = Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$token/setWebhook" -Body @{ url = $hook; secret_token = $webhookSecret; allowed_updates = '["message"]'; drop_pending_updates = 'true' }
if ($r.ok) { Write-Host "Done. Open your bot in Telegram and send /start. For YouTube/SoundCloud, run start-pc.bat." } else { Write-Host "Telegram said: $($r.description)" }
Set-Clipboard -Value " "
pause

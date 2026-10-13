# Connects the Cloudflare Worker to your Telegram bot. Copy the token from @BotFather, then run this
# (right-click -> Run with PowerShell). The token goes from the clipboard straight to Cloudflare; it isn't shown.
Set-Location $PSScriptRoot
$token = (Get-Clipboard).Trim()
if ($token -notmatch '^\d+:[\w-]{30,}$') { Write-Host "The clipboard doesn't look like a bot token. Copy it from @BotFather and try again."; pause; exit 1 }

$secret = -join ((48..57) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
$token  | npx wrangler secret put BOT_TOKEN
$secret | npx wrangler secret put WEBHOOK_SECRET

$hook = "https://tiktok-bot.didigotreizoo.workers.dev/webhook"
$r = Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$token/setWebhook" -Body @{ url = $hook; secret_token = $secret; allowed_updates = '["message"]'; drop_pending_updates = 'true' }
if ($r.ok) { Write-Host "Done. Open your bot in Telegram and send /start." } else { Write-Host "Telegram said: $($r.description)" }
Set-Clipboard -Value " "
pause

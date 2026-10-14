@echo off
rem Keeps the bot running: if node exits for any reason, start it again after 5 seconds.
cd /d "%~dp0.."
:loop
"C:\Program Files\nodejs\node.exe" server\bot.mjs >> data\bot.log 2>&1
timeout /t 5 /nobreak > nul
goto loop

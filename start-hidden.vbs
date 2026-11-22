' Starts the bot in the background with no window (server\run.cmd restarts it if it exits).
' A copy of this file in the Windows Startup folder starts the bot at every login.
Set fso = CreateObject("Scripting.FileSystemObject")
root = "C:\Users\oblivion\Desktop\projects\tiktok-bot"
CreateObject("WScript.Shell").Run "cmd /c """ & root & "\server\run.cmd""", 0, False

' DevCode direct-launch shortcut.
'
' Fires the installed Electron binary straight at the desktop-pkg directory,
' no PowerShell chain, no Tor rotation, no DB wipe. This is what the Start
' Menu + Desktop "DevCode" shortcuts point at, so a normal launch takes ~5s
' (integrity-bootstrap + window paint) instead of ~60s (full Fresh ritual).
'
' For the deliberate "reset my usage and relaunch" workflow, the Start Menu
' also installs an "DevCode Fresh (Reset)" shortcut that routes through
' fresh.ps1. This .vbs is intentionally dumb — it just spawns Electron.
'
' Also spawns the splash window first so the user sees feedback within
' ~300ms even though Electron takes a few seconds to hash the integrity
' manifest and paint its first window.
'
' Routed from:
'   (a) Start Menu "DevCode" shortcut
'   (b) Desktop "DevCode" shortcut (if the user ticked that box)
'   (c) Installer's post-install "Launch DevCode now" option

Option Explicit
Dim shell, scriptFullName, scriptDir, appRoot, electronExe, desktopPkg, splashScript, splashCmd
Set shell = CreateObject("WScript.Shell")
scriptFullName = WScript.ScriptFullName
scriptDir = Left(scriptFullName, InStrRev(scriptFullName, "\"))
' shortcuts/ sits next to electron/ and desktop-pkg/ under the install root.
appRoot = Left(scriptDir, Len(scriptDir) - Len("shortcuts\"))
electronExe = appRoot & "electron\electron.exe"
desktopPkg = appRoot & "desktop-pkg"
splashScript = appRoot & "scripts\splash.ps1"

' Splash first, hidden PowerShell runner. bWaitOnReturn=False so it runs
' detached and polls for the Electron window on its own schedule.
If CreateObject("Scripting.FileSystemObject").FileExists(splashScript) Then
    splashCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & splashScript & """"
    shell.Run splashCmd, 0, False
End If

' Then Electron. Window style 1 = SW_SHOWNORMAL so the Electron window is
' visible when it eventually paints. bWaitOnReturn=False so this .vbs exits
' immediately and no orphan wscript hangs around.
shell.Run """" & electronExe & """ """ & desktopPkg & """", 1, False

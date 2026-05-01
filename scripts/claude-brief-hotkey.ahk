; Claude Startup Kit — global hotkey.
; Press Ctrl+Alt+B from anywhere to open the brief.
; Drop this file into shell:startup so it runs at every Windows login.

#NoEnv
#SingleInstance Force
SendMode Input
SetWorkingDir %A_ScriptDir%

^!b::
    Run, "%USERPROFILE%\.claude\scripts\startup-brief-launcher.bat", , Hide
return

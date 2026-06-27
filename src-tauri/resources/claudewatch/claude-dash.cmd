@echo off
rem Terminal launcher: opens Claude + claudewatch split in Windows Terminal.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0claude-dash.ps1" %*

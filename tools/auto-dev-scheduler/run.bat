@echo off
title Auto-Dev Scheduler
cd /d "%~dp0"
if "%~1"=="" (
    powershell -ExecutionPolicy Bypass -File "auto-dev-scheduler.ps1"
) else (
    powershell -ExecutionPolicy Bypass -File "auto-dev-scheduler.ps1" -AutoDevFile "%~1"
)
pause

@echo off
title Auto-Dev Scheduler
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File "auto-dev-scheduler.ps1"
pause

@echo off
chcp 65001 >nul
node "%~dp0build-apk.js"
echo.
pause

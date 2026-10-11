@echo off
chcp 65001 >nul
echo.
echo   正在把 CSS / JS 内嵌进单个 HTML ...
echo.
node "%~dp0pack.js"
echo.
pause

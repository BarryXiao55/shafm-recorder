@echo off
setlocal
title Shanghai FM Radio Recorder v3.1
cd /d "%~dp0"

rem Locate node.exe. WorkBuddy ships a private Node build in the user profile.
set "NODE_EXE="
if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\current\node.exe" set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\current\node.exe"
if not defined NODE_EXE for /d %%d in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do if exist "%%d\node.exe" set "NODE_EXE=%%d\node.exe"
if not defined NODE_EXE for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE goto :nonode

echo.
echo   Shanghai FM Recorder v3.1 - multi-station / EPG / self-test / ffmpeg
echo   URL    : http://127.0.0.1:8787
echo   ffmpeg : bin\ffmpeg.exe -c copy, no re-encoding
echo   Manual : see the .md operation manual one folder above
echo.
echo   STOP   : red Stop Service button in UI, close this window, Ctrl+C,
echo            or run stop-service.bat
echo   RESUME : running jobs restart automatically after any restart
echo.
echo   Starting service now. The browser tab opens in a moment...
echo.
if not defined RR_NO_BROWSER start "FM990 Browser" /min powershell.exe -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8787'"
"%NODE_EXE%" server.js
echo.
echo   Server stopped. Press any key to close this window.
pause >nul
exit /b 0

:nonode
echo [ERROR] Node.js not found. Install Node.js 18+ or add it to PATH.
echo         Looked in PATH and under .workbuddy\binaries\node\versions
pause
exit /b 1

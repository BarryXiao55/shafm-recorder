@echo off
setlocal
title Install FFmpeg (optional) - Shanghai FM Recorder
cd /d "%~dp0.."
set "NODE_EXE="
if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\current\node.exe" set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\current\node.exe"
if not defined NODE_EXE for /d %%d in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do if exist "%%d\node.exe" set "NODE_EXE=%%d\node.exe"
if not defined NODE_EXE for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE goto :nonode
echo.
echo   Download and install FFmpeg (ffmpeg / ffplay / ffprobe) into bin\.
echo   The installer also updates config.json, bin\ffmpeg-location.json
echo   and bin\ffmpeg-env.bat. No existing file is deleted.
echo.
"%NODE_EXE%" tools\install-ffmpeg.js %*
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%

:nonode
echo [ERROR] Node.js 18+ not found. Install Node.js or add it to PATH.
pause
exit /b 1

@echo off
setlocal
title FM990 Recorder - Autostart Setup
cd /d "%~dp0"

echo.
echo   Install silent autostart for the FM990 Radio Recorder.
echo   Adds one VBScript and one INI in your personal Startup folder.
echo   No registry edits, no administrator rights needed.
echo.

set "NODE_EXE="
if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\current\node.exe" set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\current\node.exe"
if not defined NODE_EXE for /d %%d in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do if exist "%%d\node.exe" set "NODE_EXE=%%d\node.exe"
if not defined NODE_EXE for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE goto :nonode

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
if not exist "%STARTUP%" goto :nostartup
set "VBS=%STARTUP%\FM990Recorder.vbs"
set "INI=%STARTUP%\FM990Recorder.ini"

rem Copy the fixed launcher - no dynamic VBScript generation, no quote escaping.
copy /y "%~dp0lib\launch-hidden.vbs" "%VBS%" >nul
if errorlevel 1 goto :writefail

>  "%INI%" echo %NODE_EXE%
>> "%INI%" echo %~dp0server.js
>> "%INI%" echo %~dp0
if not exist "%VBS%" goto :writefail
if not exist "%INI%" goto :writefail

echo.
echo   DONE. Created: %VBS%
echo                  %INI%
echo   The recorder service will start silently at your next logon.
echo   Remove it with uninstall-autostart.bat.
echo   NOTE: do not also run start.bat while autostart is enabled - port 8787
echo         would already be in use and the second instance exits harmlessly.
echo.
pause >nul
exit /b 0

:nonode
echo [ERROR] Node.js not found. Install Node.js 18+ or add it to PATH.
pause
exit /b 1

:nostartup
echo [ERROR] Startup folder not found: %STARTUP%
pause
exit /b 1

:writefail
echo [ERROR] Could not write the startup entry.
echo         Target folder: %STARTUP%
pause
exit /b 1

@echo off
setlocal
title Shanghai FM Recorder - Desktop Window
cd /d "%~dp0"

rem Standalone desktop window via Edge/Chrome --app mode. No Electron needed.
rem All IF blocks are single-line with GOTO labels on purpose: cmd.exe breaks
rem multi-line parenthesis blocks, and echo lines containing parentheses
rem would corrupt such a block. This file MUST be saved with CRLF line endings.

set "URL=http://127.0.0.1:8787"
set "PROFILE=%~dp0browser-profile"
set "PF=%ProgramFiles%"
set "PF86=%ProgramFiles(x86)%"
set "LA=%LOCALAPPDATA%"

set "NODE_EXE="
if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\current\node.exe" set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\current\node.exe"
if not defined NODE_EXE for /d %%d in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do if exist "%%d\node.exe" set "NODE_EXE=%%d\node.exe"
if not defined NODE_EXE for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE goto :nonode

rem --- 1) check whether the service is already listening -------------------
"%NODE_EXE%" -e "const h=require('http');const r=h.get('http://127.0.0.1:8787/api/status',function(x){x.resume();process.exit(0)});r.on('error',function(){process.exit(1)});r.setTimeout(1500,function(){r.destroy();process.exit(1)})" >nul 2>nul
if not errorlevel 1 goto :serviceok

echo Starting recorder service in background...
powershell.exe -NoProfile -Command "Start-Process -FilePath '%NODE_EXE%' -ArgumentList 'server.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
timeout /t 3 /nobreak >nul
"%NODE_EXE%" -e "const h=require('http');const r=h.get('http://127.0.0.1:8787/api/status',function(x){x.resume();process.exit(0)});r.on('error',function(){process.exit(1)});r.setTimeout(2000,function(){r.destroy();process.exit(1)})" >nul 2>nul
if errorlevel 1 goto :servicefail

:serviceok
rem Set RR_NO_BROWSER=1 to start only the service - useful for automation or
rem when you want to open the UI yourself later.
if defined RR_NO_BROWSER goto :nobrowserwindow
rem --- 2) locate Edge or Chrome ------------------------------------------
set "BROWSER="
if exist "%PF86%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%PF86%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%PF%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%PF%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%LA%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%LA%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%PF%\Google\Chrome\Application\chrome.exe" set "BROWSER=%PF%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%PF86%\Google\Chrome\Application\chrome.exe" set "BROWSER=%PF86%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%LA%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LA%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER goto :nobrowser

echo Opening standalone window: %BROWSER%
start "" "%BROWSER%" --app=%URL% --window-size=1480,1000 --window-position=60,30 --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check
goto :opened

:nobrowser
echo [NOTE] Edge/Chrome not found - opening the default browser instead.
start "" "%URL%"

:opened
echo.
echo   Desktop window opened. Recording keeps running after you close it.
echo   To stop everything: red Stop Service button in the UI,
echo   or run stop-service.bat.
echo.
timeout /t 3 /nobreak >nul
exit /b 0

:nobrowserwindow
echo   Service is running. Browser window skipped because RR_NO_BROWSER is set.
echo   Open http://127.0.0.1:8787 yourself, or run desktop.bat normally.
timeout /t 2 /nobreak >nul
exit /b 0

:servicefail
echo [ERROR] The service did not come up on port 8787.
echo         Run start.bat to see the node error output.
pause
exit /b 1

:nonode
echo [ERROR] Node.js not found. Install Node.js 18+ or add it to PATH.
pause
exit /b 1

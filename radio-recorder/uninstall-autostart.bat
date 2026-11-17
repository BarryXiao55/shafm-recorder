@echo off
setlocal
title FM990 Recorder - Remove Autostart
set "VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\FM990Recorder.vbs"
set "INI=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\FM990Recorder.ini"

echo.
echo   Remove FM990 Radio Recorder autostart entry
echo.
if not exist "%VBS%" goto :absent
del /f /q "%VBS%"
echo   Removed: %VBS%
if exist "%INI%" del /f /q "%INI%"
if exist "%INI%" goto :inifail
goto :done

:absent
echo   No autostart entry found - nothing to do.
goto :done

:inifail
echo   [WARN] Could not remove the companion INI file: %INI%
echo          Delete it manually if it still exists.

:done
echo.
echo   NOTE: this does NOT stop a recorder service that is already running.
echo         Use the UI Stop Service button or stop-service.bat for that.
echo.
pause >nul
exit /b 0

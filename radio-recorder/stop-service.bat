@echo off
setlocal
title Shanghai FM Recorder - Stop Service
echo.
echo   Stops the local recorder service on port 8787.
echo   Audio already written to disk is kept. Running jobs are snapshotted.
echo   Preferred way: red Stop Service button in the UI.
echo.
powershell.exe -NoProfile -Command "try { Invoke-WebRequest -Uri 'http://127.0.0.1:8787/api/shutdown' -Method POST -ContentType 'application/json' -Body '{}' -UseBasicParsing -TimeoutSec 3 | Out-Null; Write-Host 'Graceful shutdown requested via /api/shutdown' } catch { Write-Host 'API not reachable - service may already be stopped' }; Start-Sleep -Milliseconds 900; $c = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $targetPid = [int]$c.OwningProcess; Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue; Write-Host ('Force-stopped leftover process PID ' + $targetPid) } else { Write-Host 'Service is stopped.' }"
echo.
echo   To start again: start.bat or desktop.bat
echo.
pause >nul
exit /b 0

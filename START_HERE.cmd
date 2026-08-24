@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
title Class Stock Simulator v3.2.0

if not exist "PUBLIC_DATA_KEY.txt" (
  echo.
  echo [NOTICE] Public data service key is not set yet.
  echo Run SET_PUBLIC_DATA_KEY.cmd first.
  echo.
)

start "Class Stock Simulator" "%ComSpec%" /k call "%~dp0RUN_SERVER.cmd"
exit /b

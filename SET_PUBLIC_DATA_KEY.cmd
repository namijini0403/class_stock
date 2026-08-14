@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
title Public Data Key Setup

echo.
echo ==============================================
echo   PUBLIC DATA SERVICE KEY SETUP
echo ==============================================
echo.
echo Paste the service key from data.go.kr.
echo Then press Enter.
echo.
set "PUBLIC_DATA_SERVICE_KEY="
set /p "PUBLIC_DATA_SERVICE_KEY=Service key: "
if not defined PUBLIC_DATA_SERVICE_KEY goto :EMPTY

>"PUBLIC_DATA_KEY.txt" set PUBLIC_DATA_SERVICE_KEY

echo.
echo [OK] The key was saved to PUBLIC_DATA_KEY.txt
echo [NEXT] Run START_HERE.cmd
echo.
pause
exit /b 0

:EMPTY
echo.
echo [ERROR] No key was entered.
echo.
pause
exit /b 1

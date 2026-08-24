@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Class Stock Simulator v3.2.0

set "LOG=%~dp0startup-log.txt"
set "NODE=%~dp0runtime\node.exe"
set "NODE_URL=https://nodejs.org/download/release/v24.19.0/win-x64/node.exe"
set "NODE_SHA256=3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237"

>"%LOG%" echo ==== Class Stock Simulator v3.2.0 startup log ====
>>"%LOG%" echo Date: %date% %time%
>>"%LOG%" echo Folder: %CD%

cls
echo ======================================================
echo   Class Stock Simulator v3.2.0 - LOCAL SERVER LAUNCHER
echo ======================================================
echo.
echo This window will stay open even if startup fails.
echo A diagnostic log is saved as startup-log.txt.
echo.

if not exist "%~dp0server.js" (
  echo [ERROR] server.js not found.
  echo Please extract the ZIP completely before running.
  >>"%LOG%" echo ERROR: server.js not found
  goto :END
)

if not exist "%~dp0node_modules\pg\package.json" (
  echo [ERROR] Server dependencies are not installed.
  echo Run npm install in this folder before START_HERE.cmd.
  echo Postgres and DATABASE_URL are also required.
  >>"%LOG%" echo ERROR: node_modules\pg missing. Run npm install first.
  goto :END
)

if not exist "%NODE%" (
  echo [1/4] Portable Node.js is not present.
  echo       Downloading the official Node.js 24 LTS runtime...
  echo       This is about 93 MB and happens only once.
  >>"%LOG%" echo Portable Node missing. Starting download.

  where curl.exe >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] Windows curl.exe was not found.
    echo Your PC may be restricted by school security policy.
    >>"%LOG%" echo ERROR: curl.exe not found
    goto :END
  )

  if not exist "%~dp0runtime" mkdir "%~dp0runtime"
  curl.exe -L --fail --retry 2 --connect-timeout 15 "%NODE_URL%" -o "%NODE%.download" >>"%LOG%" 2>&1
  if errorlevel 1 (
    echo [ERROR] Node.js download failed.
    echo Check Internet access or school security filtering.
    >>"%LOG%" echo ERROR: Node download failed
    if exist "%NODE%.download" del /q "%NODE%.download" >nul 2>nul
    goto :END
  )

  where certutil.exe >nul 2>nul
  if not errorlevel 1 (
    set "HASH="
    for /f "skip=1 tokens=*" %%H in ('certutil.exe -hashfile "%NODE%.download" SHA256 ^| findstr /R /V "hash CertUtil"') do if not defined HASH set "HASH=%%H"
    setlocal EnableDelayedExpansion
    set "HASH=!HASH: =!"
    if /I not "!HASH!"=="%NODE_SHA256%" (
      echo [ERROR] Download verification failed.
      >>"%LOG%" echo ERROR: SHA256 mismatch. Got !HASH!
      del /q "%NODE%.download" >nul 2>nul
      endlocal
      goto :END
    )
    endlocal
  ) else (
    >>"%LOG%" echo WARNING: certutil not found; SHA256 verification skipped.
  )

  move /y "%NODE%.download" "%NODE%" >nul
  echo [OK] Portable Node.js downloaded.
)

"%NODE%" -v >>"%LOG%" 2>&1
if errorlevel 1 (
  echo [ERROR] The bundled Node.js could not start.
  echo Windows security software may have blocked runtime\node.exe.
  >>"%LOG%" echo ERROR: node.exe did not run
  goto :END
)

echo [2/4] Runtime OK.
echo [3/4] Starting server...
echo.

echo Student: http://localhost:3000
echo Teacher: http://localhost:3000/teacher.html
echo.
echo The browser will open automatically in a few seconds.
echo Keep this window open while using the program.
echo.

start "" "http://localhost:3000"
>>"%LOG%" echo Starting server.js
"%NODE%" "%~dp0server.js" >>"%LOG%" 2>&1
set "CODE=%ERRORLEVEL%"
>>"%LOG%" echo Server exited. code=%CODE%

echo.
echo [SERVER STOPPED] Exit code: %CODE%
echo.

:END
echo ======================================================
echo If it did not work, send me this file:
echo   %LOG%
echo ======================================================
echo.
echo You may close this window after copying the log.
endlocal

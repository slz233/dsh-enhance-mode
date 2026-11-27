@echo off
chcp 65001 >nul
setlocal
rem @slz233/dsh-enhance-mode: read the newest session log back and check the prompt file text.

set "SCRIPT=%~dp0scripts\check-session.mjs"
if not exist "%SCRIPT%" (
  echo [check] cannot find %SCRIPT%
  pause
  exit /b 1
)

where node >nul 2>nul
if not errorlevel 1 (
  node "%SCRIPT%" %*
  goto done
)

if defined DSH_NODE_EXECUTABLE if exist "%DSH_NODE_EXECUTABLE%" (
  set "ELECTRON_RUN_AS_NODE=1"
  "%DSH_NODE_EXECUTABLE%" "%SCRIPT%" %*
  goto done
)

echo [check] no node found. Run this from a DSH shell, or install Node 22.15+.
goto done

:done
echo.
pause

@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
rem @slz233/dsh-enhance-mode: open the prompt file in Notepad.
rem Location priority: %DSH_HOME% -> dsh-home.txt next to this script -> %USERPROFILE%\.dsh

set "HOME_DIR="
if defined DSH_HOME set "HOME_DIR=%DSH_HOME%"

if not defined HOME_DIR if exist "%~dp0dsh-home.txt" (
  for /f "usebackq delims=" %%L in ("%~dp0dsh-home.txt") do (
    if not defined HOME_DIR set "HOME_DIR=%%L"
  )
)

if not defined HOME_DIR set "HOME_DIR=%USERPROFILE%\.dsh"

rem strip a trailing backslash
if "%HOME_DIR:~-1%"=="\" set "HOME_DIR=%HOME_DIR:~0,-1%"

set "TARGET=%HOME_DIR%\enhance\mode-prompt.md"

echo Prompt file:
echo   %TARGET%
echo.

if not exist "%TARGET%" (
  if not exist "%HOME_DIR%\enhance" mkdir "%HOME_DIR%\enhance" 2>nul
  if exist "%HOME_DIR%\enhance" (
    type nul > "%TARGET%"
    echo Created an empty file. Paste your text and save.
  ) else (
    echo Cannot create the folder. Check DSH_HOME or write the path into dsh-home.txt.
    pause
    exit /b 1
  )
)

start "" notepad "%TARGET%"
exit /b 0

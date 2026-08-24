@echo off
rem ---------------------------------------------------------------------------
rem  Runs the CSR Academy on this computer. Double-click this file.
rem
rem  Nothing to install: it uses the Perl that comes with Git for Windows.
rem  A small server window opens and stays open — closing it stops the academy.
rem  Everything you type is saved in this browser, on this computer only.
rem ---------------------------------------------------------------------------
setlocal
set PORT=8791

set PERL=
for %%P in (perl.exe) do if not "%%~$PATH:P"=="" set "PERL=%%~$PATH:P"
if not defined PERL if exist "%LOCALAPPDATA%\Programs\Git\usr\bin\perl.exe" set "PERL=%LOCALAPPDATA%\Programs\Git\usr\bin\perl.exe"
if not defined PERL if exist "%ProgramFiles%\Git\usr\bin\perl.exe" set "PERL=%ProgramFiles%\Git\usr\bin\perl.exe"
if not defined PERL if exist "%ProgramFiles(x86)%\Git\usr\bin\perl.exe" set "PERL=%ProgramFiles(x86)%\Git\usr\bin\perl.exe"

if not defined PERL (
  echo.
  echo Could not find perl.exe.
  echo It comes with Git for Windows: https://git-scm.com/download/win
  echo.
  pause
  exit /b 1
)

echo Starting the academy on http://localhost:%PORT%/ ...
start "CSR Academy - close this window to stop" /min "%PERL%" "%~dp0tools\serve.pl" "%~dp0public" %PORT%

rem give the server a moment before the browser asks for a page
ping -n 3 127.0.0.1 >nul

start "" "http://localhost:%PORT%/index.html"

echo.
echo The academy is open in your browser.
echo Leave the small "CSR Academy" window running. Close it when you're done.
echo.

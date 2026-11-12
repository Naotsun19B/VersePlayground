@echo off
rem Builds verse.exe from the minimum of Unreal Engine. See README.md for the requirements.
rem Arguments are passed to Scripts\Setup.ps1, for example: Setup.bat -Version ue6-main-f9f48a4bf1b9
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Scripts\Setup.ps1" %*
set SETUP_EXIT_CODE=%ERRORLEVEL%

rem Double-clicking starts Setup without arguments and closes the window when it ends, so wait for a key to keep
rem the result readable. Runs with arguments come from a terminal and do not wait.
if "%~1"=="" pause

exit /b %SETUP_EXIT_CODE%

@echo off
REM Bundle Recorder Replay — Windows double-click launcher.
REM
REM Runs replay-app.py with whichever Python is on PATH.
REM Keeps the console window open so you can read logs (and Ctrl+C to quit).

setlocal
cd /d "%~dp0"

REM Try python launcher first (the official py.exe handles versions cleanly),
REM then fall back to plain python on PATH.
where py >nul 2>nul
if %errorlevel%==0 (
    py -3 replay-app.py
    goto :done
)

where python >nul 2>nul
if %errorlevel%==0 (
    python replay-app.py
    goto :done
)

echo.
echo  [x] Python 3 not found on PATH.
echo      Install Python from https://www.python.org/downloads/
echo      (any version 3.8+ works, no extra packages needed).
echo.

:done
echo.
echo  Press any key to close this window...
pause >nul
endlocal

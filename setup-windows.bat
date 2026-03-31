@echo off
:: Tangola Engine Setup for Windows
:: Run this once to install Python dependencies.
echo === Tangola Engine Setup ===

cd /d "%~dp0engine"

where uv >nul 2>&1
if %ERRORLEVEL% == 0 (
    echo [uv found] Installing dependencies with uv...
    uv sync
) else (
    echo [uv not found] Falling back to pip...
    python -m venv .venv
    .venv\Scripts\python.exe -m pip install --upgrade pip
    .venv\Scripts\python.exe -m pip install pyaudio soundcard websockets numpy
)

echo.
echo Done! You can now run Tangola.
pause

@echo off
chcp 65001 >nul
echo ========================================
echo   coolAI Build Script (Windows)
echo ========================================
echo.

REM Check Node.js
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js not found. Please install Node.js 20+ from https://nodejs.org
    exit /b 1
)

echo [1/3] Installing dependencies...
call npm install
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Failed to install dependencies
    exit /b 1
)

echo.
echo [2/3] Building TypeScript...
call npm run build
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Build failed
    exit /b 1
)

echo.
echo [3/3] Creating global command...
call npm link
if %ERRORLEVEL% neq 0 (
    echo [WARN] Failed to create global command. Run 'npm link' manually as administrator.
)

echo.
echo ========================================
echo   Build Complete!
echo ========================================
echo.
echo Run 'coolAI' to start the application.
echo.
pause

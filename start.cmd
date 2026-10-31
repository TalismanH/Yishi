@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "src-tauri\target\release\yishi-desktop.exe" (
  start "" "src-tauri\target\release\yishi-desktop.exe"
  exit /b 0
)
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。请安装 Node.js 22 或更新版本后重新启动。
  pause
  exit /b 1
)
call npm start
if errorlevel 1 pause

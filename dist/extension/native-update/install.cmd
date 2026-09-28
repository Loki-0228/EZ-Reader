@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo.
  echo Git 自动更新安装失败，请查看上方提示。
  pause
  exit /b 1
)
echo.
echo EZ-Reader 一键更新已启用。
pause

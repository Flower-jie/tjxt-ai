@echo off
chcp 65001 >nul
cd /d %~dp0
echo 正在启动 天机AI助手 前端...
start "" http://localhost:5173
node server.js
pause

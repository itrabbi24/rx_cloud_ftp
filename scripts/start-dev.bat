@echo off
rem Development launcher: runs the console server from source (needs Node.js 18+).
title Rx Cloude (dev)
cd /d "%~dp0.."
node src\launcher.js
pause

@echo off
set PLAYWRIGHT_BROWSERS_PATH=E:\playwright_browsers
cd /d C:\Users\Martin\Documents\trend_monitor
node trend_monitor.js >> trend_monitor_stdout.log 2>&1

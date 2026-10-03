@echo off
REM One-click fix when the sweep alerts "X rotated its API id": re-capture the request template,
REM then push it so GitHub Actions picks it up on the next sweep.
cd /d C:\Users\Martin\Documents\trend_monitor
node x_api_capture.js || (echo Capture failed & pause & exit /b 1)
git add x_api_template.json
git commit -m "Refresh X API template (query id rotation)"
git pull --rebase --autostash origin main
git push origin main
echo Done - next sweep uses the new template.
pause

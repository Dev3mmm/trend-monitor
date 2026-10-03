@echo off
REM One-click fix when the sweep alerts "X session expired": log the scraper account in again,
REM then upload the new session to the GitHub secret the sweep reads.
cd /d C:\Users\Martin\Documents\trend_monitor
node x_login.js || (echo Login failed & pause & exit /b 1)
powershell -NoProfile -Command "[Convert]::ToBase64String([IO.File]::ReadAllBytes('x_state.json')) | gh secret set X_STATE_JSON_B64 --repo Dev3mmm/trend-monitor"
echo Secret updated - next sweep uses the new session.
pause

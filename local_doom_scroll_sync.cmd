@echo off
REM Runs the X doom-scroll lane from this PC's own (non-datacenter) IP, since GitHub Actions'
REM cloud runner IPs get Cloudflare-walled on x.com/home (confirmed 2026-09-29 - see
REM project_trend_monitor.md memory). Pulls latest first (the cloud sweep also commits to the
REM same repo), runs the scroll, then commits+pushes whatever changed.
cd /d C:\Users\Martin\Documents\trend_monitor

git pull --rebase origin main --quiet

node doom_scroll_agent.js 10 >> doom_scroll_local_run.log 2>&1

git add dashboard_activity_log.json doom_scroll_debug_home.png doom_scroll_debug_explore.png
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "Local doom-scroll sweep (home IP) %date% %time%"
  git push origin main
  if errorlevel 1 (
    git pull --rebase origin main --quiet
    git push origin main
  )
)

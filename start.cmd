@echo off
cd /d "%~dp0"
echo Starting FLEX Phase 1 UAT check-off server...
start "" http://localhost:4180
node server.mjs

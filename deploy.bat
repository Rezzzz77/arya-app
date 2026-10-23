@echo off
setlocal
cd /d "%~dp0"
echo === install ===
call npm.cmd install
if errorlevel 1 exit /b 1
echo === scrape catalog ===
call node scripts\scrape-arya.js
if errorlevel 1 exit /b 1
echo === D1 schema ===
call wrangler.cmd d1 execute arya-app-db --remote --file=worker/schema.sql
if errorlevel 1 exit /b 1
echo === deploy worker ===
call node scripts\deploy-worker.js
if errorlevel 1 exit /b 1
echo === deploy pages ===
call node scripts\deploy-pages.js
if errorlevel 1 exit /b 1
echo Done.

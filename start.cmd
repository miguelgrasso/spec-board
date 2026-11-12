@echo off
REM spec-board: arranca el bridge local + Claude Code con el mod cargado, para el proyecto actual.
REM Ejecutar desde la raiz del proyecto que tiene .kiro/specs y .claude/spec-board.json:
REM   ..\spec-board\start.cmd            (continua la ultima sesion de esta carpeta)
REM   ..\spec-board\start.cmd <session>  (reanuda una sesion concreta)
setlocal
set "TOOL=%~dp0"
set "PROJECT=%CD%"
if not exist "%PROJECT%\.kiro\specs" echo [spec-board] Aviso: %PROJECT% no tiene .kiro\specs
set "PY=%PROJECT%\.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

REM 1) Bridge del dashboard (si no esta corriendo ya); hereda el proyecto como cwd
tasklist /FI "WINDOWTITLE eq spec-board-bridge*" 2>nul | find /I "python" >nul || start "spec-board-bridge" /min /d "%PROJECT%" "%PY%" "%TOOL%bridge\bridge.py"
echo Dashboard local: http://127.0.0.1:8787/board

REM 2) Binario de Claude Code: el CLI instalado (se actualiza con `claude update`) o, si falta, el de una extension
set "CLAUDE="
if exist "%USERPROFILE%\.local\bin\claude.exe" set "CLAUDE=%USERPROFILE%\.local\bin\claude.exe"
for /f "delims=" %%D in ('dir /b /ad /o-n "%USERPROFILE%\.vscode\extensions\anthropic.claude-code-*" 2^>nul') do (
  if not defined CLAUDE if exist "%USERPROFILE%\.vscode\extensions\%%D\resources\native-binary\claude.exe" set "CLAUDE=%USERPROFILE%\.vscode\extensions\%%D\resources\native-binary\claude.exe"
)
if not defined CLAUDE set "CLAUDE=%USERPROFILE%\.local\bin\claude.exe"
echo Claude: %CLAUDE%

REM 3) Sesion con el mod
if "%~1"=="" (
  "%CLAUDE%" --continue --plugin-dir "%TOOL%mod"
) else (
  "%CLAUDE%" --resume %~1 --plugin-dir "%TOOL%mod"
)

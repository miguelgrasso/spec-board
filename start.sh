#!/usr/bin/env sh
# spec-board: starts the local bridge + Claude Code with the mod loaded, for the current project.
# Run from the root of the project that has .kiro/specs and .claude/spec-board.json:
#   ../spec-board/start.sh            (continues the last session of this folder)
#   ../spec-board/start.sh <session>  (resumes a specific session)
set -u
TOOL=$(cd "$(dirname "$0")" && pwd)
PROJECT=$(pwd)
[ -d "$PROJECT/.kiro/specs" ] || echo "[spec-board] Aviso: $PROJECT no tiene .kiro/specs"

PY="$PROJECT/.venv/bin/python"
[ -x "$PY" ] || PY=python3

# 1) Dashboard bridge (unless already answering); inherits the project as cwd
if ! curl -fs -o /dev/null http://127.0.0.1:8787/health 2>/dev/null; then
  nohup "$PY" "$TOOL/bridge/bridge.py" >/dev/null 2>&1 &
fi
echo "Dashboard local: http://127.0.0.1:8787/board"

# 2) Claude Code binary: PATH first, then the usual installer location
CLAUDE=$(command -v claude 2>/dev/null || true)
[ -n "$CLAUDE" ] || CLAUDE="$HOME/.local/bin/claude"
echo "Claude: $CLAUDE"

# 3) Session with the mod
if [ "${1:-}" = "" ]; then
  exec "$CLAUDE" --continue --plugin-dir "$TOOL/mod"
else
  exec "$CLAUDE" --resume "$1" --plugin-dir "$TOOL/mod"
fi

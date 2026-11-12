"""Spec Board bridge — turns a click on the web dashboard into a local, autonomous
`claude -p` run for one Kiro task.

    (from the root of the project that holds .kiro/specs and .claude/spec-board.json)
    .venv\\Scripts\\python.exe ..\\spec-board\\bridge\\bridge.py            # serve on 127.0.0.1:8787
    .venv\\Scripts\\python.exe ..\\spec-board\\bridge\\bridge.py --port 8790

Routes
    GET /                       the dashboard (data.js regenerated from the spec on every load)
    GET /runs                   status page: allowed tasks and recent runs
    GET /run?task=A24&mode=run  implement the task (also mode=test to verify only)
        &dry=1                  show prompt + command without launching anything
        &json=1                 answer with the job as JSON instead of redirecting
    GET /job/<id>               live log of one run (auto-refreshing page)
    GET /job/<id>/raw           the log as text
    GET /job/<id>/json          the job as JSON
    GET /health                 JSON: {ok, repo, spec, claude, running}
    GET /jobs.json              JSON: the last 50 jobs
    GET /regen                  regenerate data.js from the spec, JSON result

Settings: `.claude/spec-board.json` at the repo root (optional) — specsDir, spec,
allowedTasks (regex), bridge.url, dashboard.python. Shared with the Claude Code mod.

Safety (pilot scope = Phase A):
    * only task ids matching ^A\\d+(\\.\\d+)?$ may run; B* and A-Checkpoint are refused
    * the agent gets a tool allow-list: edit files in the repo + pytest/mypy/ruff + git status/diff
    * AWS_* credentials are stripped from the agent's environment
    * one run at a time per task
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import subprocess
import sys
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent          # this tool (bridge.py, gen_spec_data.py, index.html)
# The project served: the working directory the bridge is started from (or SPEC_BOARD_REPO).
REPO = Path(os.environ.get("SPEC_BOARD_REPO") or Path.cwd()).resolve()


def load_config() -> dict:
    """Per-project settings shared with the mod: `.claude/spec-board.json` (optional)."""
    defaults = {
        "specsDir": ".kiro/specs",
        "spec": "swarm-guard",
        "allowedTasks": r"^A\d+(\.\d+)?$",
        "bridge": {"url": "http://127.0.0.1:8787"},
        "dashboard": {"dir": ".claude/spec-board", "python": ".venv/Scripts/python.exe"},
    }
    path = REPO / ".claude" / "spec-board.json"
    if path.exists():
        try:
            user = json.loads(path.read_text(encoding="utf-8"))
            for k, v in user.items():
                if isinstance(v, dict) and isinstance(defaults.get(k), dict):
                    defaults[k].update(v)
                else:
                    defaults[k] = v
        except (OSError, ValueError) as exc:
            print(f"[bridge] config ignorada ({path.name}): {exc}", file=sys.stderr)
    return defaults


CONFIG = load_config()
SPEC_DIR = REPO / CONFIG["specsDir"] / CONFIG["spec"]
DATA_DIR = REPO / CONFIG["dashboard"]["dir"]     # generated data.js (+ a copy of index.html) and runs/, per project
RUNS_DIR = DATA_DIR / "runs"
PYTHON = REPO / CONFIG["dashboard"]["python"]

sys.path.insert(0, str(HERE))
import gen_spec_data as gen  # noqa: E402  (same folder)

ALLOWED_TASK = re.compile(CONFIG["allowedTasks"])
CLAUDE_CANDIDATES = [
    os.environ.get("CLAUDE_BIN", ""),
    os.path.expanduser(r"~\.local\bin\claude.exe"),
    r"C:\Users\Usuario\.kiro\extensions\anthropic.claude-code-2.1.319-win32-x64\resources\native-binary\claude.exe",
    r"C:\Users\Usuario\.vscode\extensions\anthropic.claude-code-2.1.282-win32-x64\resources\native-binary\claude.exe",
    r"C:\Users\Usuario\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe",
    "claude",
]
ALLOWED_TOOLS = [
    "Read", "Glob", "Grep", "Edit", "MultiEdit", "Write",
    "Bash(.venv/Scripts/python.exe -m pytest:*)",
    "Bash(.venv/Scripts/python.exe -m mypy:*)",
    "Bash(.venv/Scripts/python.exe -m ruff:*)",
    "Bash(.venv\\Scripts\\python.exe -m pytest:*)",
    "Bash(.venv\\Scripts\\python.exe -m mypy:*)",
    "Bash(.venv\\Scripts\\python.exe -m ruff:*)",
    "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)",
]
SYSTEM_RULES = (
    f"Eres un agente autónomo que ejecuta UNA tarea del spec Kiro `{CONFIG['spec']}` en el repo local. "
    "Reglas duras: no hagas git commit/push/rm; no uses aws ni ningún comando de red; no toques tareas de la fase B; "
    "no modifiques requirements.md ni design.md; usa solo el Python de .venv. "
    "Si una tarea exige algo fuera de estas reglas, detente y explícalo. "
    "Termina SIEMPRE con una línea final exacta: `RESULTADO: HECHA|PARCIAL|FALLÓ — <resumen de una línea>`."
)

_jobs: dict[str, dict] = {}
_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Spec data and prompts
# ---------------------------------------------------------------------------

def load_spec() -> dict:
    tasks = gen.parse_tasks((SPEC_DIR / "tasks.md").read_text(encoding="utf-8"))
    gen.compute_status(tasks)
    requirements = gen.parse_requirements((SPEC_DIR / "requirements.md").read_text(encoding="utf-8"))
    design = gen.parse_design((SPEC_DIR / "design.md").read_text(encoding="utf-8"))
    for t in tasks:
        t["design"] = gen.design_for(design, t)
    return {"tasks": {t["id"]: t for t in tasks}, "requirements": requirements}


def build_prompt(spec: dict, task: dict, mode: str) -> str:
    reqs = [f"- {r}: {spec['requirements'].get(r, {}).get('text', '(ver requirements.md)')}" for r in task["requirements"]]
    design = [f"- § {d['heading']} (design.md:{d['line']})" for d in task["design"][:6]]
    subs = [spec["tasks"][s] for s in task["subtaskIds"] if s in spec["tasks"]]
    lines = []
    spec_name = CONFIG["spec"]
    tasks_md = f"{CONFIG['specsDir']}/{spec_name}/tasks.md"
    if mode == "test":
        lines.append(f'Verifica la tarea {task["id"]} del spec {spec_name}: "{task["title"]}". No modifiques código ni specs: solo comprueba y reporta.')
    else:
        lines.append(f'Ejecuta la tarea {task["id"]} del spec {spec_name}: "{task["title"]}".')
    lines.append(f"{tasks_md}:{task['line']} tiene la descripción completa; léela primero.")
    if subs:
        lines.append("Subtareas:")
        lines += [f"- [{'x' if s['status'] == 'done' else ' '}] {s['id']} {s['title']}" for s in subs]
    if task["body"]:
        lines.append("Qué hace:")
        lines += [f"- {b}" for b in task["body"]]
    if reqs:
        lines.append("Requirements que debe cumplir:")
        lines += reqs
    if design:
        lines.append("Secciones de design relacionadas:")
        lines += design
    lines.append(f"Criterio de verificación: {task['verify'] or '(derívalo de la descripción y los requirements)'}")
    if mode == "test":
        lines.append("Haz esto: 1) ejecuta literalmente el criterio y pega la salida relevante; 2) PASS/FAIL por requirement con evidencia archivo:línea; "
                     "3) di si el criterio es tautológico; 4) veredicto CUMPLE / PARCIAL / NO CUMPLE.")
    else:
        lines.append("Implementa la tarea, ejecuta su criterio de verificación y, SOLO si pasa, cambia su casilla `- [ ]` por `- [x]` en tasks.md "
                     "(únicamente esa línea). Si no pasa, deja la casilla como está y explica qué falta.")
    return "\n".join(lines)


def find_claude() -> str:
    for c in CLAUDE_CANDIDATES:
        if c and (Path(c).exists() or c == "claude"):
            return c
    return "claude"


def agent_env() -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith("AWS_")}
    env.pop("BEDROCK_MODEL_ID", None)
    return env


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------

def start_job(task_id: str, mode: str, dry: bool) -> dict:
    spec = load_spec()
    task = spec["tasks"].get(task_id)
    if task is None:
        raise ValueError(f"Tarea desconocida: {task_id}")
    if not ALLOWED_TASK.match(task_id):
        raise PermissionError(f"{task_id} no está en el alcance del piloto (solo tareas A<n> de la fase A; B* y A-Checkpoint se hacen a mano).")
    prompt = build_prompt(spec, task, mode)
    cmd = [find_claude(), "-p", prompt, "--output-format", "text",
           "--permission-mode", "acceptEdits",
           "--append-system-prompt", SYSTEM_RULES,
           "--allowedTools", *ALLOWED_TOOLS]
    job_id = f"{task_id}-{mode}-{datetime.now():%Y%m%d-%H%M%S}"
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    log = RUNS_DIR / f"{job_id}.log"
    job = {"id": job_id, "task": task_id, "mode": mode, "title": task["title"], "log": str(log),
           "status": "dry" if dry else "running", "started": time.time(), "finished": None, "exit": None, "result": ""}
    with _lock:
        if not dry:
            for other in _jobs.values():
                if other["task"] == task_id and other["status"] == "running":
                    raise RuntimeError(f"Ya hay una ejecución en curso para {task_id}: {other['id']}")
        _jobs[job_id] = job
    header = f"# {job_id}\n# cwd: {REPO}\n# cmd: {' '.join(repr(c) if ' ' in c else c for c in cmd[:1])} -p <prompt> ... --allowedTools {len(ALLOWED_TOOLS)} patterns\n\n--- PROMPT ---\n{prompt}\n--- /PROMPT ---\n\n"
    log.write_text(header, encoding="utf-8")
    if dry:
        job["status"] = "dry"
        job["finished"] = time.time()
        return job
    threading.Thread(target=_run, args=(job, cmd, log), daemon=True).start()
    return job


def public_job(job: dict) -> dict:
    """The fields the mod and other clients get (no command line, no prompt)."""
    return {k: job[k] for k in ("id", "task", "mode", "title", "status", "result", "started", "finished", "exit", "log")}


def _run(job: dict, cmd: list[str], log: Path) -> None:
    try:
        with log.open("a", encoding="utf-8") as fh:
            proc = subprocess.Popen(cmd, cwd=str(REPO), env=agent_env(), stdout=fh, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
            job["exit"] = proc.wait()
    except Exception as exc:  # noqa: BLE001
        with log.open("a", encoding="utf-8") as fh:
            fh.write(f"\n[bridge] no se pudo lanzar claude: {exc}\n")
        job["exit"] = -1
    text = log.read_text(encoding="utf-8", errors="replace")
    m = re.findall(r"RESULTADO:\s*(HECHA|PARCIAL|FALL[ÓO])\s*[—-]\s*(.*)", text)
    job["result"] = f"{m[-1][0]} — {m[-1][1].strip()}" if m else ("sin línea RESULTADO" if job["exit"] == 0 else f"exit {job['exit']}")
    job["status"] = "done" if job["exit"] == 0 else "failed"
    job["finished"] = time.time()


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

CSS = """<style>body{background:#16161e;color:#c0caf5;font:14px/1.5 'IBM Plex Sans',system-ui,sans-serif;margin:0;padding:24px;max-width:960px}
h1,h2,code,pre,.id{font-family:'JetBrains Mono',Consolas,monospace}h1{color:#c84bff;text-shadow:0 0 10px rgba(200,75,255,.6);font-size:18px;text-transform:uppercase;letter-spacing:.04em}
a{color:#7dcfff}pre{background:#1a1b26;border:1px solid #3b4261;border-left:3px solid #c84bff;padding:12px;white-space:pre-wrap;word-break:break-word;max-height:70vh;overflow:auto}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
.running{background:#3a2e17;color:#e0af68}.done{background:#2e1a44;color:#c84bff}.failed{background:#3d1f29;color:#f7768e}.dry{background:#24283b;color:#7dcfff}
table{border-collapse:collapse;width:100%}td,th{padding:6px 8px;border-bottom:1px solid #3b4261;text-align:left}.muted{color:#7a84b3}</style>"""


def page(title: str, body: str, refresh: int | None = None) -> bytes:
    meta = f'<meta http-equiv="refresh" content="{refresh}">' if refresh else ""
    return f"<!doctype html><meta charset=utf-8>{meta}<title>{html.escape(title)}</title>{CSS}<h1>&gt; spec-board bridge_</h1>{body}".encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:  # quieter console
        sys.stderr.write(f"[bridge] {self.address_string()} {fmt % args}\n")

    def _send(self, body: bytes, status: int = 200, ctype: str = "text/html; charset=utf-8") -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, payload: object, status: int = 200) -> None:
        self._send(json.dumps(payload, ensure_ascii=False).encode("utf-8"), status, "application/json; charset=utf-8")

    def do_GET(self) -> None:  # noqa: N802
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        want_json = q.get("json") == "1" or "application/json" in self.headers.get("Accept", "")
        try:
            # --- JSON API (used by the Claude Code mod) ---
            if url.path == "/health":
                return self._json({"ok": True, "repo": str(REPO), "spec": CONFIG["spec"], "claude": find_claude(),
                                   "running": sum(1 for j in _jobs.values() if j["status"] == "running")})
            if url.path == "/jobs.json":
                jobs = sorted(_jobs.values(), key=lambda j: j["started"], reverse=True)[:50]
                return self._json([public_job(j) for j in jobs])
            if url.path == "/regen":
                gen.main_to(SPEC_DIR, DATA_DIR)
                data = DATA_DIR / "data.js"
                return self._json({"ok": True, "data": str(data), "bytes": data.stat().st_size})
            if url.path in ("/", "/board", "/board/", "/index.html"):
                # The dashboard itself, with data regenerated from the spec on every load.
                gen.main_to(SPEC_DIR, DATA_DIR)
                html_text = (HERE / "index.html").read_text(encoding="utf-8")
                doc = ('<!doctype html><html><head><meta charset="utf-8">'
                       '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
                       '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>'
                       f'</head><body>{html_text}</body></html>')
                return self._send(doc.encode("utf-8"))
            if url.path == "/data.js":
                return self._send((DATA_DIR / "data.js").read_bytes(), ctype="application/javascript; charset=utf-8")
            if url.path == "/runs":
                return self._send(self.index())
            if url.path == "/run":
                task_id = (q.get("task") or "").strip()
                mode = "test" if q.get("mode") == "test" else "run"
                job = start_job(task_id, mode, dry=q.get("dry") == "1")
                if want_json:
                    return self._json(public_job(job))
                if job["status"] == "dry":
                    return self._send(self.job_page(job))
                self.send_response(303)
                self.send_header("Location", f"/job/{job['id']}")
                self.end_headers()
                return None
            m = re.match(r"^/job/([A-Za-z0-9.\-]+)(/raw|/json)?$", url.path)
            if m:
                job = _jobs.get(m.group(1))
                if job is None:
                    if want_json or m.group(2) == "/json":
                        return self._json({"error": "Ejecución desconocida."}, 404)
                    return self._send(page("no encontrado", "<p>Ejecución desconocida.</p>"), 404)
                if m.group(2) == "/json":
                    return self._json(public_job(job))
                if m.group(2):
                    return self._send(Path(job["log"]).read_bytes(), ctype="text/plain; charset=utf-8")
                return self._send(self.job_page(job))
            if want_json:
                return self._json({"error": "Ruta desconocida."}, 404)
            return self._send(page("404", "<p>Ruta desconocida.</p>"), 404)
        except (ValueError, PermissionError, RuntimeError) as exc:
            if want_json:
                return self._json({"error": str(exc)}, 400)
            return self._send(page("rechazado", f"<p class=failed style='padding:8px'>{html.escape(str(exc))}</p><p><a href='/'>volver</a></p>"), 400)

    def index(self) -> bytes:
        spec = load_spec()
        allowed = [t for t in spec["tasks"].values() if ALLOWED_TASK.match(t["id"]) and not t["parentId"]]
        rows = "".join(
            f"<tr><td class=id>{t['id']}</td><td>{html.escape(t['title'])}</td><td class=muted>{t['status']} {t['percent']}%</td>"
            f"<td><a href='/run?task={t['id']}&mode=run'>▶ ejecutar</a> · <a href='/run?task={t['id']}&mode=test'>✓ testear</a> · "
            f"<a class=muted href='/run?task={t['id']}&mode=run&dry=1'>dry</a></td></tr>" for t in allowed)
        jobs = sorted(_jobs.values(), key=lambda j: j["started"], reverse=True)[:20]
        jrows = "".join(
            f"<tr><td><a href='/job/{j['id']}'>{j['id']}</a></td><td><span class='pill {j['status']}'>{j['status']}</span></td>"
            f"<td>{html.escape(j['result'])}</td></tr>" for j in jobs) or "<tr><td colspan=3 class=muted>sin ejecuciones aún</td></tr>"
        body = (f"<p class=muted>repo {html.escape(str(REPO))} · claude: {html.escape(find_claude())} · alcance piloto: tareas A&lt;n&gt; de la fase A</p>"
                f"<h2>Tareas</h2><table><tr><th>id</th><th>título</th><th>estado</th><th></th></tr>{rows}</table>"
                f"<h2>Ejecuciones</h2><table><tr><th>id</th><th>estado</th><th>resultado</th></tr>{jrows}</table>")
        return page("spec-board bridge", body)

    def job_page(self, job: dict) -> bytes:
        text = Path(job["log"]).read_text(encoding="utf-8", errors="replace")
        tail = text[-20000:]
        elapsed = int((job["finished"] or time.time()) - job["started"])
        status = job["status"]
        head = (f"<p><span class='pill {status}'>{status}</span> <b class=id>{job['task']}</b> {html.escape(job['title'])} "
                f"<span class=muted>· modo {job['mode']} · {elapsed}s</span></p>")
        if job["result"]:
            head += f"<p><b>Resultado:</b> {html.escape(job['result'])}</p>"
        if status == "dry":
            head += "<p class=muted>Ensayo: nada se ejecutó. Este es el prompt y el entorno que recibiría el agente.</p>"
        body = head + f"<pre>{html.escape(tail)}</pre><p><a href='/board'>← dashboard</a> · <a href='/runs'>ejecuciones</a> · <a href='/job/{job['id']}/raw'>log completo</a></p>"
        return page(f"{job['task']} {job['mode']}", body, refresh=3 if status == "running" else None)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    default_port = int(urlparse(CONFIG["bridge"].get("url", "http://127.0.0.1:8787")).port or 8787)
    ap.add_argument("--port", type=int, default=default_port)
    args = ap.parse_args()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[bridge] spec-board bridge en http://{args.host}:{args.port}  (repo {REPO}, claude {find_claude()})", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()

"""Extract a Kiro spec (tasks.md, requirements.md, design.md) into data.js for the Spec Board page.

Usage: python -I gen_spec_data.py <spec_dir> <out_dir>
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

TASK_LINE = re.compile(r"^(\s*)- \[([ xX\-~])\](\*?)\s+(.+?)\s*$")
TASK_ID = re.compile(r"^([A-Za-z]{0,3}\d+(?:\.\d+)*|[A-Za-z]-[A-Za-z]+)\.?\s+(.*)$")
REQ_LINE = re.compile(r"_Requirements:\s*([^_]+)_")
VALIDATES = re.compile(r"Validates:\s*Requirements?\s*([\d.,\s]+)")
PROP_REF = re.compile(r"\b(?:Design\s+)?P(\d+)\b")
SKIP_PHASES = {"tasks", "overview", "notes", "task dependency graph"}
STOP_WORDS = {
    "design", "overview", "architecture", "components", "interfaces", "models", "data",
    "adversarial", "scenarios", "infrastructure", "code", "decision", "records",
    "assumptions", "limitations", "error", "handling", "errores", "testing", "strategy",
    "correctness", "properties", "property", "pruebas", "flujo", "principal", "captura",
    "versión", "version", "asumida", "cuenta", "stack", "recursos", "outputs", "should_continue",
    "swarm", "strands", "agents", "graph", "contexto",
}


def split_refs(raw: str) -> list[str]:
    out = []
    for part in re.split(r"[,\s]+", raw):
        part = part.strip().rstrip(".")
        if re.fullmatch(r"\d+(\.\d+)?", part):
            out.append(part)
    return out


def uniq(items: list[str]) -> list[str]:
    seen: list[str] = []
    for i in items:
        if i not in seen:
            seen.append(i)
    return seen


def parse_tasks(text: str) -> list[dict]:
    tasks: list[dict] = []
    phase = ""
    parent = current = None
    in_fence = False
    for index, line in enumerate(text.splitlines(), start=1):
        if line.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        h = re.match(r"^##\s+(.+?)\s*$", line)
        if h:
            name = h.group(1)
            phase = "" if name.lower() in SKIP_PHASES else name
            parent = current = None
            continue
        t = TASK_LINE.match(line)
        if t:
            indent = len(t.group(1))
            rest = t.group(4)
            m = TASK_ID.match(rest)
            item = {
                "id": m.group(1) if m else f"L{index}",
                "title": re.sub(r"\s+", " ", (m.group(2) if m else rest)).strip(),
                "mark": t.group(2).lower(),
                "optional": t.group(3) == "*",
                "line": index,
                "phase": phase,
                "parentId": None,
                "subtaskIds": [],
                "requirements": [],
                "properties": [f"P{p}" for p in PROP_REF.findall(rest)],
                "body": [],
                "verify": "",
                "_text": rest.lower(),
                "_verify_mode": False,
            }
            if indent == 0 or parent is None:
                parent = item
            else:
                item["parentId"] = parent["id"]
                parent["subtaskIds"].append(item["id"])
            current = item
            tasks.append(item)
            continue
        if current is None:
            continue
        current["_text"] += " " + line.lower()
        stripped = line.strip()
        crit = re.match(r"^\*\*Criterio de verificaci[oó]n:?\*\*:?\s*(.*)$", stripped, re.I)
        if crit:
            current["_verify_mode"] = True
            current["verify"] = crit.group(1).strip()
            continue
        if current["_verify_mode"]:
            if not stripped or stripped.startswith(("- [", "_Requirements")):
                current["_verify_mode"] = False
            else:
                current["verify"] = (current["verify"] + " " + stripped).strip()
                continue
        if stripped and "_Requirements:" not in stripped:
            if stripped.startswith("- ") or stripped.startswith("* "):
                current["body"].append(stripped[2:].strip())
        r = REQ_LINE.search(line)
        if r:
            current["requirements"] += split_refs(r.group(1))
        v = VALIDATES.search(line)
        if v:
            current["requirements"] += split_refs(v.group(1))
            current["properties"] += [f"P{p}" for p in PROP_REF.findall(line)]
    for t in tasks:
        t["requirements"] = uniq(t["requirements"])
        t["properties"] = uniq(t["properties"])
        t["body"] = t["body"][:6]
    return tasks


def compute_status(tasks: list[dict]) -> None:
    by_id = {t["id"]: t for t in tasks}
    for t in tasks:
        if not t["parentId"]:
            continue
        if t["mark"] == "x":
            t["status"], t["percent"] = "done", 100
        elif t["mark"] in "-~":
            t["status"], t["percent"] = "progress", 50
        else:
            t["status"], t["percent"] = "pending", 0
    for t in tasks:
        if t["parentId"]:
            continue
        subs = [by_id[s] for s in t["subtaskIds"] if s in by_id]
        if t["mark"] == "x":
            t["status"], t["percent"] = "done", 100
        elif subs and sum(s["percent"] for s in subs) > 0:
            ratio = sum(s["percent"] for s in subs) / len(subs)
            t["status"], t["percent"] = "progress", min(95, round(ratio))
        elif t["mark"] in "-~":
            t["status"], t["percent"] = "progress", 50
        else:
            t["status"], t["percent"] = "pending", 0


def build_phases(tasks: list[dict]) -> list[dict]:
    order: list[str] = []
    groups: dict[str, list[dict]] = {}
    for t in tasks:
        if t["parentId"]:
            continue
        name = t["phase"] or "Tasks"
        if name not in groups:
            groups[name] = []
            order.append(name)
        groups[name].append(t)
    phases = []
    for name in order:
        lst = groups[name]
        done = sum(1 for t in lst if t["status"] == "done")
        prog = sum(1 for t in lst if t["status"] == "progress")
        short = re.sub(r"^(phase|fase|etapa|stage)\s+", "", name, flags=re.I)
        short = re.split(r"[\s—:–-]+", short)[0] or name
        phases.append({
            "name": name,
            "short": short,
            "taskIds": [t["id"] for t in lst],
            "done": done,
            "progress": prog,
            "pending": len(lst) - done - prog,
            "percent": round(sum(t["percent"] for t in lst) / len(lst)) if lst else 0,
        })
    return phases


def parse_requirements(text: str) -> dict[str, dict]:
    out: dict[str, dict] = {}
    req_num = req_title = ""
    story = ""
    for index, line in enumerate(text.splitlines(), start=1):
        m = re.match(r"^###\s+Requirement\s+(\d+)\s*:\s*(.+?)\s*$", line, re.I)
        if m:
            req_num, req_title = m.group(1), m.group(2)
            story = ""
            out[req_num] = {"id": req_num, "title": req_title, "text": req_title, "line": index, "story": ""}
            continue
        p = re.match(r"^###\s+(P\d+)\s*[—:-]\s*(.+?)\s*$", line)
        if p:
            req_num = ""
            out[p.group(1)] = {"id": p.group(1), "title": p.group(2), "text": p.group(2), "line": index, "story": ""}
            continue
        if line.startswith("## "):
            req_num = ""
            continue
        s = re.match(r"^\*\*User Story:\*\*\s*(.+)$", line)
        if s and req_num:
            story = s.group(1).strip()
            out[req_num]["story"] = story
            continue
        ac = re.match(r"^(\d+)\.\s+(.+?)\s*$", line)
        if ac and req_num:
            rid = f"{req_num}.{ac.group(1)}"
            out[rid] = {"id": rid, "title": req_title, "text": ac.group(2), "line": index, "story": story}
    return out


def parse_design(text: str) -> list[dict]:
    out: list[dict] = []
    for index, line in enumerate(text.splitlines(), start=1):
        h = re.match(r"^(##|###)\s+(.+?)\s*$", line)
        if h:
            heading = h.group(2)
            words = [
                w.lower()
                for w in re.split(r"[^A-Za-z0-9_\-]+", heading)
                if (len(w) >= 5 or re.fullmatch(r"ADR-\d+", w, re.I))
            ]
            words = [w for w in words if w not in STOP_WORDS and not w[0].isdigit()]
            out.append({"heading": heading, "line": index, "level": len(h.group(1)), "validates": [], "words": words, "excerpt": ""})
            continue
        if not out:
            continue
        last = out[-1]
        v = VALIDATES.search(line)
        if v:
            last["validates"] += split_refs(v.group(1))
        stripped = line.strip()
        if stripped and not last["excerpt"] and not stripped.startswith(("```", "|", "**Validates", "**##", "#", "---")):
            last["excerpt"] = stripped[:220]
    return out


def design_for(design: list[dict], task: dict) -> list[dict]:
    hits: list[dict] = []
    seen: set[int] = set()

    def add(h: dict, via: str) -> None:
        if h["line"] in seen:
            return
        seen.add(h["line"])
        hits.append({"heading": h["heading"], "line": h["line"], "via": via, "excerpt": h["excerpt"]})

    for h in design:
        shared = [v for v in h["validates"] if v in task["requirements"]]
        if shared:
            add(h, "valida " + ", ".join(shared))
    for p in task["properties"]:
        n = p[1:]
        for h in design:
            if re.match(rf"^Property\s+{n}\b", h["heading"], re.I):
                add(h, p)
    for h in design:
        for w in h["words"]:
            if w in task["_text"]:
                add(h, w)
                break
    return hits[:8]


def main() -> None:
    main_to(Path(sys.argv[1]), Path(sys.argv[2]))


def main_to(spec_dir: Path, out_dir: Path) -> None:
    """Generate data.js for *spec_dir* into *out_dir* (importable entry point).

    index.html is copied next to data.js when missing or outdated, so *out_dir* is a
    complete, publishable dashboard.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    src_html = Path(__file__).resolve().parent / "index.html"
    dst_html = out_dir / "index.html"
    if src_html.exists() and src_html.resolve() != dst_html.resolve():
        if not dst_html.exists() or dst_html.read_bytes() != src_html.read_bytes():
            dst_html.write_bytes(src_html.read_bytes())
    tasks_text = (spec_dir / "tasks.md").read_text(encoding="utf-8")
    req_text = (spec_dir / "requirements.md").read_text(encoding="utf-8") if (spec_dir / "requirements.md").exists() else ""
    design_text = (spec_dir / "design.md").read_text(encoding="utf-8") if (spec_dir / "design.md").exists() else ""

    tasks = parse_tasks(tasks_text)
    compute_status(tasks)
    phases = build_phases(tasks)
    requirements = parse_requirements(req_text)
    design = parse_design(design_text)
    for t in tasks:
        t["design"] = design_for(design, t)
        del t["_text"]
        del t["_verify_mode"]
    top = [t for t in tasks if not t["parentId"]]
    done = sum(1 for t in top if t["status"] == "done")
    prog = sum(1 for t in top if t["status"] == "progress")
    data = {
        "spec": spec_dir.name,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "files": {"tasks": "tasks.md", "requirements": "requirements.md", "design": "design.md"},
        "totals": {"total": len(top), "done": done, "progress": prog, "pending": len(top) - done - prog,
                   "percent": round(sum(t["percent"] for t in top) / len(top)) if top else 0,
                   "subtasks": len(tasks) - len(top)},
        "phases": phases,
        "tasks": tasks,
        "requirements": requirements,
        "designCount": len(design),
    }
    (out_dir / "data.js").write_text("window.SPEC_DATA = " + json.dumps(data, ensure_ascii=False, indent=1) + ";\n", encoding="utf-8")
    print(f"{data['spec']}: {done}/{len(top)} done, {prog} in progress, {len(requirements)} req items, {len(design)} design headings")
    print(f"written {out_dir / 'data.js'} ({(out_dir / 'data.js').stat().st_size} bytes)")


if __name__ == "__main__":
    main()

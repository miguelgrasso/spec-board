# spec-board

Semáforo de tareas para specs de [Kiro](https://kiro.dev) (`.kiro/specs/<spec>/tasks.md`), en dos vistas
sincronizadas:

- **Mod de Claude Code** (`mod/`): un panel junto al chat con el progreso por fase, trazabilidad a
  `requirements.md` y `design.md`, y el comando `/spec-board` para encolar tareas.
- **Dashboard web + bridge local** (`bridge/`): `bridge.py` sirve el tablero en `http://127.0.0.1:8787/board`
  y convierte un clic en una tarea en una ejecución autónoma de `claude -p` con una lista blanca de
  herramientas. `gen_spec_data.py` genera `data.js` a partir del spec.

Flujo de trabajo pensado para "Kiro escribe la spec, Claude Code la ejecuta y valida".

## Requisitos

- Windows (el arranque usa `start.cmd`; el bridge y el generador son Python puro y portables).
- Python 3.11+ (se usa el `.venv` del proyecto si existe).
- Claude Code CLI.

## Uso en un proyecto

1. En la raíz del proyecto crea `.claude/spec-board.json` (todos los campos son opcionales):

   ```json
   {
     "specsDir": ".kiro/specs",
     "spec": "mi-spec",
     "pollMs": 4000,
     "allowedTasks": "^A\d+(\.\d+)?$",
     "bridge": {
       "url": "http://127.0.0.1:8787",
       "autoStart": true,
       "start": [".venv/Scripts/python.exe", "../spec-board/bridge/bridge.py"]
     },
     "dashboard": {
       "dir": ".claude/spec-board",
       "generator": "../spec-board/bridge/gen_spec_data.py",
       "python": ".venv/Scripts/python.exe",
       "artifactUrl": ""
     }
   }
   ```

   `allowedTasks` es la expresión regular de las tareas que el bridge puede ejecutar sin supervisión.
   `dashboard.dir` recibe los archivos generados por proyecto (`data.js`, copia de `index.html`, `runs/`);
   conviene tenerlo en `.gitignore`.

2. Desde la raíz del proyecto:

   ```bat
   ..\spec-board\start.cmd            # bridge + Claude Code con el mod, continúa la última sesión
   ..\spec-board\start.cmd <session>  # reanuda una sesión concreta
   ```

   O por separado: `python ..\spec-board\bridge\bridge.py` para el bridge y
   `claude --plugin-dir ..\spec-board\mod` para el mod.

## Rutas del bridge

| Ruta | Función |
| --- | --- |
| `GET /board` | Dashboard (regenera `data.js` en cada carga) |
| `GET /runs` | Tareas permitidas y ejecuciones recientes |
| `GET /run?task=A24&mode=run` | Implementa la tarea (`mode=test` solo verifica; `&dry=1` muestra el prompt; `&json=1` responde JSON) |
| `GET /regen` | Regenera `data.js` |
| `GET /jobs.json`, `GET /job/<id>/json` | Estado de los trabajos |
| `GET /health` | Comprobación de vida |

## Seguridad del bridge

Los agentes lanzados por el bridge reciben solo una lista blanca de herramientas (sin
`--dangerously-skip-permissions`), sin `git commit`/`push`/`rm`, sin red ni AWS CLI, con las variables
`AWS_*` eliminadas del entorno, y solo para tareas que cumplan `allowedTasks`. Escucha únicamente en
`127.0.0.1`.

## Desarrollo del mod

```bat
claude plugin validate mod
claude plugin test mod
```

`mod/.claude-plugin/types/` lo escribe el motor de Claude Code al cargar el mod y está ignorado por git.

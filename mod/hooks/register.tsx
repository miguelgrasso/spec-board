import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  Board,
  DesignHeading,
  Job,
  Jobs,
  Phase,
  ReqItem,
  SpecBoard,
  Task,
  TaskStatus,
} from '../types'

// ---------------------------------------------------------------------------
// Identity, configuration and state
// ---------------------------------------------------------------------------

const PANE = 'spec-board'
const COMMAND = 'spec-board'
const CONFIG_FILE = '.claude/spec-board.json'
const STORE_PREFIX = 'progress:'
const AUTO_REGEN_KEY = 'auto-regen'
const REGEN_DEBOUNCE_MS = 5_000

/** Per-project settings, `.claude/spec-board.json`; every field optional there. */
type Config = {
  specsDir: string
  spec: string
  pollMs: number
  allowedTasks: string
  bridge: { url: string; autoStart: boolean; start: string[] }
  dashboard: { dir: string; generator: string; python: string; artifactUrl: string }
}

const DEFAULTS: Config = {
  specsDir: '.kiro/specs',
  spec: '',
  pollMs: 4000,
  allowedTasks: '^A\\d+(\\.\\d+)?$',
  bridge: {
    url: 'http://127.0.0.1:8787',
    autoStart: true,
    start: ['.venv/Scripts/python.exe', '.claude/spec-board/bridge.py'],
  },
  dashboard: {
    dir: '.claude/spec-board',
    generator: '.claude/spec-board/gen_spec_data.py',
    python: '.venv/Scripts/python.exe',
    artifactUrl: '',
  },
}

const EMPTY: Board = { specs: [], loadedAt: 0 }

// Bump the shape when Board/Jobs change: an older stored value is then declined.
const board = atom({ plugin: 'spec-board', key: 'board' } as const, EMPTY, { shape: 'board-1' })
const selected = atom({ plugin: 'spec-board', key: 'selected' } as const, null as string | null)
const jobs = atom({ plugin: 'spec-board', key: 'jobs' } as const, {} as Jobs, { shape: 'jobs-1' })

// Module-local: lost on reload, rebuilt by the next refresh.
let config: Config = DEFAULTS
let lastSignature = ''
let pendingChanges: string[] = []
let regenTimer: { cancel: () => void } | undefined
let pollTimer: { cancel: () => void } | undefined

type Engine = EngineInterface

// ---------------------------------------------------------------------------
// Parsing: tasks.md
// ---------------------------------------------------------------------------

const TASK_LINE = /^(\s*)- \[([ xX\-~])\](\*?)\s+(.+?)\s*$/
const TASK_ID = /^([A-Za-z]{0,3}\d+(?:\.\d+)*|[A-Za-z]-[A-Za-z]+)\.?\s+(.*)$/
const REQ_LINE = /_Requirements:\s*([^_]+)_/
const VALIDATES_LINE = /Validates:\s*Requirements?\s*([\d.,\s]+)/
const PROPERTY_REF = /\b(?:Design\s+)?P(\d+)\b/g
const SKIP_PHASES = new Set(['tasks', 'overview', 'notes', 'task dependency graph'])

type RawTask = Task & { indent: number }

function propertyRefs(text: string): string[] {
  return [...text.matchAll(PROPERTY_REF)].map(m => `P${m[1] ?? ''}`)
}

function parseTasks(text: string): Task[] {
  const lines = text.split(/\r?\n/)
  const tasks: RawTask[] = []
  let phase = ''
  let parent: RawTask | undefined
  let current: RawTask | undefined
  let inFence = false

  lines.forEach((line, index) => {
    if (/^```/.test(line)) {
      inFence = !inFence
      return
    }
    if (inFence) return

    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      const name = heading[1] ?? ''
      phase = SKIP_PHASES.has(name.toLowerCase()) ? '' : name
      parent = undefined
      current = undefined
      return
    }

    const task = TASK_LINE.exec(line)
    if (task) {
      const indent = (task[1] ?? '').length
      const mark = (task[2] ?? ' ').toLowerCase()
      const optional = task[3] === '*'
      const rest = task[4] ?? ''
      const idMatch = TASK_ID.exec(rest)
      const id = idMatch?.[1] ?? `L${index + 1}`
      const title = (idMatch?.[2] ?? rest).replace(/\s+/g, ' ').trim()
      const item: RawTask = {
        id,
        title,
        mark,
        optional,
        status: 'pending',
        percent: 0,
        line: index + 1,
        phase,
        subtaskIds: [],
        requirements: [],
        properties: uniq(propertyRefs(title)),
        text: title.toLowerCase(),
        indent,
      }
      if (indent === 0 || !parent) {
        parent = item
      } else {
        item.parentId = parent.id
        parent.subtaskIds.push(item.id)
      }
      current = item
      tasks.push(item)
      return
    }

    if (!current) return
    current.text += ' ' + line.toLowerCase()
    const req = REQ_LINE.exec(line)
    if (req) current.requirements.push(...splitRefs(req[1] ?? ''))
    const val = VALIDATES_LINE.exec(line)
    if (val) {
      current.requirements.push(...splitRefs(val[1] ?? ''))
      current.properties.push(...propertyRefs(line))
    }
  })

  for (const task of tasks) {
    task.requirements = uniq(task.requirements)
    task.properties = uniq(task.properties)
  }
  return tasks.map(({ indent: _indent, ...task }) => task)
}

function splitRefs(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map(s => s.trim().replace(/\.$/, ''))
    .filter(s => /^\d+(\.\d+)?$/.test(s))
}

function uniq<T>(list: T[]): T[] {
  return [...new Set(list)]
}

// ---------------------------------------------------------------------------
// Status and percentages
// ---------------------------------------------------------------------------

function computeStatus(tasks: Task[], overrides: Record<string, number>): void {
  const byId = new Map(tasks.map(t => [t.id, t]))

  // Subtasks first: they have no children of their own.
  for (const t of tasks) {
    if (!t.parentId) continue
    const override = overrides[t.id]
    if (t.mark === 'x') {
      t.status = 'done'
      t.percent = 100
    } else if (override !== undefined && override > 0) {
      t.status = override >= 100 ? 'done' : 'progress'
      t.percent = clamp(override)
    } else if (t.mark === '-' || t.mark === '~') {
      t.status = 'progress'
      t.percent = 50
    } else {
      t.status = 'pending'
      t.percent = 0
    }
  }

  // Parents: their own box, a manual override, or the mean of their children.
  for (const t of tasks) {
    if (t.parentId) continue
    const subs = t.subtaskIds.map(id => byId.get(id)).filter((s): s is Task => s !== undefined)
    const override = overrides[t.id]
    if (t.mark === 'x') {
      t.status = 'done'
      t.percent = 100
      continue
    }
    if (override !== undefined && override > 0) {
      t.status = override >= 100 ? 'done' : 'progress'
      t.percent = clamp(override)
      continue
    }
    if (subs.length > 0) {
      const ratio = subs.reduce((sum, s) => sum + s.percent, 0) / subs.length
      if (ratio > 0) {
        // The parent box is still unchecked: cap below 100 so it reads as "almost".
        t.status = 'progress'
        t.percent = Math.min(95, Math.round(ratio))
        continue
      }
    }
    if (t.mark === '-' || t.mark === '~') {
      t.status = 'progress'
      t.percent = 50
      continue
    }
    t.status = 'pending'
    t.percent = 0
  }
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)))
}

function buildPhases(tasks: Task[]): Phase[] {
  const order: string[] = []
  const groups = new Map<string, Task[]>()
  for (const t of tasks) {
    if (t.parentId) continue
    const name = t.phase || 'Tasks'
    const bucket = groups.get(name)
    if (bucket) {
      bucket.push(t)
    } else {
      groups.set(name, [t])
      order.push(name)
    }
  }
  return order.map(name => {
    const list = groups.get(name) ?? []
    const done = list.filter(t => t.status === 'done').length
    const progress = list.filter(t => t.status === 'progress').length
    const pending = list.length - done - progress
    const percent = list.length
      ? Math.round(list.reduce((s, t) => s + t.percent, 0) / list.length)
      : 0
    return { name, short: shortPhase(name), taskIds: list.map(t => t.id), percent, done, progress, pending }
  })
}

function shortPhase(name: string): string {
  const stripped = name.replace(/^(phase|fase|etapa|stage)\s+/i, '')
  return stripped.split(/[\s—:–-]+/)[0] || name
}

// ---------------------------------------------------------------------------
// Parsing: requirements.md and design.md
// ---------------------------------------------------------------------------

function parseRequirements(text: string): Record<string, ReqItem> {
  const out: Record<string, ReqItem> = {}
  let reqNum = ''
  let reqTitle = ''
  text.split(/\r?\n/).forEach((line, index) => {
    const req = /^###\s+Requirement\s+(\d+)\s*:\s*(.+?)\s*$/i.exec(line)
    if (req) {
      reqNum = req[1] ?? ''
      reqTitle = req[2] ?? ''
      out[reqNum] = { id: reqNum, title: reqTitle, text: reqTitle, line: index + 1 }
      return
    }
    const prop = /^###\s+(P\d+)\s*[—:-]\s*(.+?)\s*$/.exec(line)
    if (prop) {
      reqNum = ''
      const id = prop[1] ?? ''
      const title = prop[2] ?? ''
      out[id] = { id, title, text: title, line: index + 1 }
      return
    }
    if (/^##\s/.test(line)) {
      reqNum = ''
      return
    }
    const ac = /^(\d+)\.\s+(.+?)\s*$/.exec(line)
    if (ac && reqNum) {
      const id = `${reqNum}.${ac[1] ?? ''}`
      out[id] = { id, title: reqTitle, text: ac[2] ?? '', line: index + 1 }
    }
  })
  return out
}

const STOP_WORDS = new Set([
  'design', 'overview', 'architecture', 'components', 'interfaces', 'models', 'data',
  'adversarial', 'scenarios', 'infrastructure', 'code', 'decision', 'records',
  'assumptions', 'limitations', 'error', 'handling', 'errores', 'testing', 'strategy',
  'correctness', 'properties', 'property', 'pruebas', 'flujo', 'principal', 'captura',
  'versión', 'version', 'asumida', 'cuenta', 'stack', 'recursos', 'outputs', 'should_continue',
])

function parseDesign(text: string): DesignHeading[] {
  const out: DesignHeading[] = []
  text.split(/\r?\n/).forEach((line, index) => {
    const h = /^(##|###)\s+(.+?)\s*$/.exec(line)
    if (h) {
      const heading = h[2] ?? ''
      const words = heading
        .split(/[^A-Za-z0-9_\-]+/)
        .filter(w => w.length >= 5 || /^ADR-\d+$/i.test(w))
        .map(w => w.toLowerCase())
        .filter(w => !STOP_WORDS.has(w) && !/^\d/.test(w))
      out.push({ heading, line: index + 1, level: (h[1] ?? '##').length, validates: [], words })
      return
    }
    const last = out[out.length - 1]
    if (!last) return
    const val = VALIDATES_LINE.exec(line)
    if (val) last.validates.push(...splitRefs(val[1] ?? ''))
  })
  return out
}

function designFor(spec: SpecBoard, task: Task): { heading: DesignHeading; via: string }[] {
  const hits: { heading: DesignHeading; via: string }[] = []
  const seen = new Set<number>()
  const add = (heading: DesignHeading, via: string) => {
    if (seen.has(heading.line)) return
    seen.add(heading.line)
    hits.push({ heading, via })
  }
  for (const h of spec.design) {
    const shared = h.validates.filter(v => task.requirements.includes(v))
    if (shared.length) add(h, `valida ${shared.join(', ')}`)
  }
  for (const p of task.properties) {
    const n = p.slice(1)
    const h = spec.design.find(d => new RegExp(`^Property\\s+${n}\\b`, 'i').test(d.heading))
    if (h) add(h, p)
  }
  for (const h of spec.design) {
    const word = h.words.find(w => task.text.includes(w))
    if (word) add(h, word)
  }
  return hits.slice(0, 8)
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function strList(v: unknown, fallback: string[]): string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string') && v.length > 0 ? (v as string[]) : fallback
}

/** `.claude/spec-board.json` merged over the defaults; the defaults alone when absent or broken. */
async function loadConfig($: Engine): Promise<Config> {
  const text = await readOr($, CONFIG_FILE)
  if (!text.trim()) return DEFAULTS
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return DEFAULTS
  }
  if (!isRecord(raw)) return DEFAULTS
  const b = isRecord(raw.bridge) ? raw.bridge : {}
  const d = isRecord(raw.dashboard) ? raw.dashboard : {}
  return {
    specsDir: str(raw.specsDir, DEFAULTS.specsDir).replace(/\/+$/, ''),
    spec: str(raw.spec, DEFAULTS.spec),
    pollMs: num(raw.pollMs, DEFAULTS.pollMs),
    allowedTasks: str(raw.allowedTasks, DEFAULTS.allowedTasks),
    bridge: {
      url: str(b.url, DEFAULTS.bridge.url).replace(/\/+$/, ''),
      autoStart: bool(b.autoStart, DEFAULTS.bridge.autoStart),
      start: strList(b.start, DEFAULTS.bridge.start),
    },
    dashboard: {
      dir: str(d.dir, DEFAULTS.dashboard.dir),
      generator: str(d.generator, DEFAULTS.dashboard.generator),
      python: str(d.python, DEFAULTS.dashboard.python),
      artifactUrl: str(d.artifactUrl, DEFAULTS.dashboard.artifactUrl),
    },
  }
}

function allowedByBridge(taskId: string): boolean {
  try {
    return new RegExp(config.allowedTasks).test(taskId)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Loading (every helper takes the engine as `$`; atoms are touched in hooks)
// ---------------------------------------------------------------------------

async function readOr($: Engine, path: string): Promise<string> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}

async function mtime($: Engine, path: string): Promise<number> {
  try {
    return (await $.fs.stat(path)).mtimeMs
  } catch {
    return 0
  }
}

async function listSpecDirs($: Engine): Promise<string[]> {
  try {
    const entries = await $.fs.list(config.specsDir)
    const dirs: string[] = []
    for (const entry of entries) {
      if (entry.kind !== 'dir') continue
      if (await $.fs.exists(`${config.specsDir}/${entry.name}/tasks.md`)) dirs.push(entry.name)
    }
    return dirs.sort()
  } catch {
    return []
  }
}

async function signature($: Engine, dirs: string[]): Promise<string> {
  const parts: string[] = []
  for (const dir of dirs) {
    for (const file of ['tasks.md', 'requirements.md', 'design.md']) {
      parts.push(String(await mtime($, `${config.specsDir}/${dir}/${file}`)))
    }
  }
  return dirs.join('|') + '#' + parts.join(',')
}

async function loadOverrides($: Engine): Promise<Record<string, Record<string, number>>> {
  const out: Record<string, Record<string, number>> = {}
  try {
    for (const key of await $.store.keys()) {
      if (!key.startsWith(STORE_PREFIX)) continue
      const [spec, task] = key.slice(STORE_PREFIX.length).split('/')
      const value = await $.store.get(key)
      if (typeof value === 'number' && spec && task) {
        const bucket = out[spec] ?? (out[spec] = {})
        bucket[task] = value
      }
    }
  } catch {
    // The store is a convenience; the board draws without it.
  }
  return out
}

async function loadAidlc($: Engine): Promise<string | undefined> {
  try {
    const space = (await readOr($, 'aidlc/active-space')).trim() || 'default'
    const intent = (await readOr($, `aidlc/spaces/${space}/intents/active-intent`)).trim()
    if (!intent) return undefined
    const state = await readOr($, `aidlc/spaces/${space}/intents/${intent}/aidlc-state.md`)
    if (!state) return `${intent} (sin aidlc-state.md)`
    const line = state
      .split(/\r?\n/)
      .map(l => l.trim())
      .find(l => /\b(stage|phase|status|etapa|fase|estado)\b/i.test(l) && !l.startsWith('#'))
    return `${intent}: ${line ?? 'estado no legible'}`.slice(0, 160)
  } catch {
    return undefined
  }
}

async function loadBoard($: Engine): Promise<Board> {
  const dirs = await listSpecDirs($)
  const loadedAt = await $.clock.now()
  if (dirs.length === 0) {
    return { specs: [], loadedAt, error: `No hay specs en ${config.specsDir}/` }
  }
  const overrides = await loadOverrides($)
  const specs: SpecBoard[] = []
  for (const dir of dirs) {
    const base = `${config.specsDir}/${dir}`
    const tasks = parseTasks(await readOr($, `${base}/tasks.md`))
    computeStatus(tasks, overrides[dir] ?? {})
    const phases = buildPhases(tasks)
    const top = tasks.filter(t => !t.parentId)
    const done = top.filter(t => t.status === 'done').length
    const progress = top.filter(t => t.status === 'progress').length
    specs.push({
      name: dir,
      dir: base,
      phases,
      tasks,
      requirements: parseRequirements(await readOr($, `${base}/requirements.md`)),
      design: parseDesign(await readOr($, `${base}/design.md`)),
      done,
      progress,
      pending: top.length - done - progress,
      total: top.length,
      percent: top.length ? Math.round(top.reduce((s, t) => s + t.percent, 0) / top.length) : 0,
    })
  }
  return { specs, loadedAt, aidlc: await loadAidlc($) }
}

/** Reloads the board when a spec file changed (or when forced); undefined when nothing changed. */
async function loadIfChanged($: Engine, force: boolean): Promise<Board | undefined> {
  const dirs = await listSpecDirs($)
  const sig = await signature($, dirs)
  if (!force && sig === lastSignature) return undefined
  lastSignature = sig
  return loadBoard($)
}

/** Task-status transitions between two boards, as "A22: pending → done" lines. */
function diffBoards(before: Board, after: Board): string[] {
  const prev = new Map<string, string>()
  for (const s of before.specs) for (const t of s.tasks) prev.set(`${s.name}/${t.id}`, `${t.status}:${t.percent}`)
  const out: string[] = []
  for (const s of after.specs) {
    for (const t of s.tasks) {
      const key = `${s.name}/${t.id}`
      const was = prev.get(key)
      const now = `${t.status}:${t.percent}`
      if (was === undefined) {
        if (before.specs.length) out.push(`${t.id}: nueva (${t.status})`)
      } else if (was !== now) {
        const [ws] = was.split(':')
        out.push(`${t.id}: ${ws} → ${t.status}${t.status === 'progress' ? ` ${t.percent}%` : ''}`)
      }
    }
  }
  return out
}

function shortList(items: string[], max: number): string {
  return items.slice(0, max).join('; ') + (items.length > max ? `; +${items.length - max} más` : '')
}

// ---------------------------------------------------------------------------
// Bridge (local HTTP server that runs one task in an isolated `claude -p`)
// ---------------------------------------------------------------------------

type BridgeReply = { ok: boolean; status: number; text: string; json: unknown }

async function bridgeGet($: Engine, path: string): Promise<BridgeReply> {
  try {
    const r = await $.http.fetch(`${config.bridge.url}${path}`, { headers: { Accept: 'application/json' } })
    let json: unknown = undefined
    try {
      json = JSON.parse(r.text)
    } catch {
      json = undefined
    }
    return { ok: r.ok, status: r.status, text: r.text, json }
  } catch (err) {
    return { ok: false, status: 0, text: err instanceof Error ? err.message : String(err), json: undefined }
  }
}

async function bridgeUp($: Engine): Promise<boolean> {
  const r = await bridgeGet($, '/health')
  return r.ok && isRecord(r.json) && r.json.ok === true
}

function sleep($: Engine, ms: number): Promise<void> {
  return new Promise(resolve => {
    $.clock.after(ms, () => resolve())
  })
}

/** The bridge, started if it is down and the config allows it; false when still unreachable. */
async function ensureBridge($: Engine): Promise<boolean> {
  if (await bridgeUp($)) return true
  if (!config.bridge.autoStart || config.bridge.start.length === 0) return false
  try {
    // Detached through `start` so the server outlives the call (and the session).
    await $.process.run(['cmd', '/c', 'start', 'spec-board-bridge', '/min', ...config.bridge.start], { timeoutMs: 15_000 })
  } catch {
    return false
  }
  for (let i = 0; i < 12; i++) {
    await sleep($, 500)
    if (await bridgeUp($)) return true
  }
  return false
}

function asJob(v: unknown): Job | undefined {
  if (!isRecord(v) || typeof v.id !== 'string' || typeof v.task !== 'string') return undefined
  const status = v.status === 'running' || v.status === 'done' || v.status === 'failed' || v.status === 'dry' ? v.status : 'failed'
  return {
    id: v.id,
    task: v.task,
    mode: v.mode === 'test' ? 'test' : 'run',
    status,
    result: typeof v.result === 'string' ? v.result : '',
    started: typeof v.started === 'number' ? v.started : 0,
    finished: typeof v.finished === 'number' ? v.finished : null,
    log: typeof v.log === 'string' ? v.log : '',
  }
}

function startHint(): string {
  return `Arráncalo con \`${config.bridge.start.join(' ')}\` (o ..\\spec-board\\start.cmd desde la raíz del proyecto)`
}

/** Asks the bridge to run or verify a task; returns the job (to store) and a line for the person. */
async function launchJob($: Engine, task: Task, mode: 'run' | 'test'): Promise<{ job?: Job; text: string }> {
  if (!allowedByBridge(task.id)) {
    return {
      text: `${task.id} está fuera del alcance del bridge (${config.allowedTasks}). Hazla a mano o con "/spec-board ${mode} ${task.id} here" para encolarla en esta sesión.`,
    }
  }
  if (!(await ensureBridge($))) {
    return { text: `Bridge no disponible en ${config.bridge.url}. ${startHint()}.` }
  }
  const r = await bridgeGet($, `/run?task=${encodeURIComponent(task.id)}&mode=${mode}&json=1`)
  const job = asJob(r.json)
  if (r.ok && job) {
    const verb = mode === 'test' ? 'Verificación' : 'Ejecución'
    return { job, text: `${verb} de ${task.id} lanzada en el bridge: ${job.id} · log ${job.log} · ${config.bridge.url}/job/${job.id}` }
  }
  const reason = isRecord(r.json) && typeof r.json.error === 'string' ? r.json.error : r.text.slice(0, 200)
  return { text: `El bridge rechazó ${task.id}: ${reason}` }
}

/** The bridge's job list merged over what we know; `finished` lists jobs that just ended. */
async function pollJobs($: Engine, known: Jobs): Promise<{ jobs: Jobs; finished: Job[] } | undefined> {
  const r = await bridgeGet($, '/jobs.json')
  if (!r.ok || !Array.isArray(r.json)) return undefined
  const next: Jobs = { ...known }
  const finished: Job[] = []
  for (const raw of r.json) {
    const job = asJob(raw)
    if (!job) continue
    const was = known[job.id]
    if (was && was.status === 'running' && job.status !== 'running') finished.push(job)
    next[job.id] = job
  }
  return { jobs: next, finished }
}

function hasRunning(all: Jobs): boolean {
  return Object.values(all).some(j => j.status === 'running')
}

function latestJobFor(all: Jobs, taskId: string): Job | undefined {
  let best: Job | undefined
  for (const j of Object.values(all)) {
    if (j.task !== taskId) continue
    if (!best || j.started > best.started) best = j
  }
  return best
}

function jobChip(job: Job | undefined, now: number): string {
  if (!job) return ''
  if (job.status === 'running') {
    const secs = Math.max(0, Math.round(now / 1000 - job.started))
    const t = secs < 90 ? `${secs}s` : `${Math.round(secs / 60)}m`
    return ` ⟳ ${job.mode} ${t}`
  }
  if (job.status === 'done') return ` ✔ ${job.result.split(' — ')[0] ?? 'HECHA'}`
  if (job.status === 'failed') return ' ✖ falló'
  return ''
}

function jobToast(job: Job): string {
  const verb = job.mode === 'test' ? 'verificación' : 'ejecución'
  const mark = job.status === 'done' ? '✔' : '✖'
  return `spec-board: ${mark} ${job.task} ${verb} terminó — ${job.result || job.status}`
}

// ---------------------------------------------------------------------------
// Dashboard regeneration (local, no model turn)
// ---------------------------------------------------------------------------

/** Regenerates data.js: through the bridge when up, else by running the generator. */
async function regenerate($: Engine): Promise<string> {
  if (await bridgeUp($)) {
    const r = await bridgeGet($, '/regen')
    if (r.ok) return 'dashboard regenerado (bridge)'
    return `el bridge no pudo regenerar: ${r.text.slice(0, 120)}`
  }
  const spec = config.spec || 'swarm-guard'
  try {
    const out = await $.process.run(
      [config.dashboard.python, '-I', config.dashboard.generator, `${config.specsDir}/${spec}`, config.dashboard.dir],
      { timeoutMs: 60_000 },
    )
    return out.exitCode === 0 ? 'dashboard regenerado (local)' : `generador falló (exit ${out.exitCode}): ${out.stderr.slice(0, 120)}`
  } catch (err) {
    return `no se pudo regenerar: ${err instanceof Error ? err.message : String(err)}`
  }
}

/** Debounced: collects status changes and, once quiet, regenerates data.js once. */
async function scheduleRegen($: Engine, changes: string[]): Promise<void> {
  if (changes.length === 0) return
  const enabled = await $.store.get(AUTO_REGEN_KEY).catch(() => true)
  if (enabled === false) return
  pendingChanges.push(...changes)
  regenTimer?.cancel()
  regenTimer = $.clock.after(REGEN_DEBOUNCE_MS, () => {
    const batch = pendingChanges
    pendingChanges = []
    regenTimer = undefined
    if (batch.length === 0) return
    void regenerate($).then(msg => $.ui.toast(`spec-board: ${msg}`)).catch(() => undefined)
  })
}

/** What a reload must announce: a toast with the transitions, and the debounced regeneration. */
async function announce($: Engine, before: Board, fresh: Board): Promise<void> {
  const changes = diffBoards(before, fresh)
  if (changes.length === 0) return
  $.ui.toast(`spec-board: ${shortList(changes, 3)}`)
  await scheduleRegen($, changes)
}

// ---------------------------------------------------------------------------
// Prompts (only on explicit request)
// ---------------------------------------------------------------------------

function publishPrompt(): string {
  const d = config.dashboard
  const spec = config.spec || 'swarm-guard'
  return [
    '[spec-board] Publica el dashboard web del spec sin preguntar:',
    `1) ejecuta \`${d.python} -I ${d.generator} ${config.specsDir}/${spec} ${d.dir}\``,
    `2) publica ${d.dir}/index.html con el Artifact tool pasando url=${d.artifactUrl} y files {"data.js": "${d.dir}/data.js"} (sin icon ni capabilities: se conservan).`,
    'Responde en una sola línea con lo que cambió. Si el generador falla, di por qué y no publiques.',
  ].join('\n')
}

/** The same errand the bridge sends, built locally for `/spec-board run|test <id> here`. */
function taskPrompt(spec: SpecBoard, task: Task, mode: 'run' | 'test'): string {
  const reqs = task.requirements.map(r => {
    const item = spec.requirements[r]
    return `- ${r}: ${item ? item.text : '(ver requirements.md)'}`
  })
  const design = designFor(spec, task).map(d => `- § ${d.heading.heading} (design.md:${d.heading.line})`)
  const subs = task.subtaskIds.map(id => spec.tasks.find(t => t.id === id)).filter((s): s is Task => s !== undefined)
  const head =
    mode === 'test'
      ? `Verifica la tarea ${task.id} del spec ${spec.name}: "${task.title}". No modifiques código ni specs: solo comprueba y reporta.`
      : `Ejecuta la tarea ${task.id} del spec ${spec.name}: "${task.title}".`
  const tail =
    mode === 'test'
      ? 'Haz esto: 1) ejecuta literalmente el criterio de verificación de la tarea (está en tasks.md bajo "Criterio de verificación") y pega la salida relevante; 2) para cada requirement indica PASS o FAIL con evidencia (archivo:línea o salida); 3) si el criterio es tautológico o no prueba el requirement, dilo; 4) veredicto final: CUMPLE / CUMPLE PARCIALMENTE / NO CUMPLE y qué falta.'
      : 'Lee la descripción completa y el criterio de verificación en tasks.md, implementa la tarea, ejecuta el criterio y, solo si pasa, marca su casilla como [x] en tasks.md.'
  return [
    `[spec-board] ${head}`,
    `Ubicación: ${spec.dir}/tasks.md:${task.line}${task.parentId ? ` (subtarea de ${task.parentId})` : ''}.`,
    ...(subs.length ? ['Subtareas:', ...subs.map(s => `- [${s.status === 'done' ? 'x' : ' '}] ${s.id} ${s.title}`)] : []),
    ...(reqs.length ? ['Requirements:', ...reqs] : []),
    ...(design.length ? ['Secciones de design relacionadas:', ...design] : []),
    tail,
  ].join('\n')
}

function statusLine(b: Board): string | undefined {
  if (b.specs.length === 0) return undefined
  return b.specs
    .map(s => {
      const phases = s.phases.map(p => `${p.short} ${p.percent}%`).join(' · ')
      return `${s.name} ${s.done}/${s.total} ✓ ${s.percent}%${phases ? '  ' + phases : ''}`
    })
    .join(' | ')
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const LIGHT: Record<TaskStatus, { glyph: string; color: string }> = {
  done: { glyph: '●', color: 'green' },
  progress: { glyph: '◐', color: 'yellow' },
  pending: { glyph: '○', color: 'red' },
}

function bar(percent: number, width: number): string {
  const w = Math.max(4, width)
  const filled = Math.round((clamp(percent) / 100) * w)
  return '█'.repeat(filled) + '░'.repeat(w - filled)
}

function fit(text: string, width: number): string {
  if (width <= 1) return ''
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + '…'
}

function findTask(b: Board, key: string | null): { spec: SpecBoard; task: Task } | undefined {
  if (!key) return undefined
  const [specName, taskId] = key.split('/')
  const spec = b.specs.find(s => s.name === specName) ?? b.specs[0]
  const task = spec?.tasks.find(t => t.id === taskId)
  return spec && task ? { spec, task } : undefined
}

function describe(spec: SpecBoard, task: Task, job: Job | undefined): string {
  const light = LIGHT[task.status]
  const lines = [
    `${light.glyph} ${task.id} ${task.title} — ${task.status} ${task.percent}% (tasks.md:${task.line})`,
  ]
  if (task.subtaskIds.length) {
    lines.push('Subtareas:')
    for (const id of task.subtaskIds) {
      const s = spec.tasks.find(t => t.id === id)
      if (s) lines.push(`  ${LIGHT[s.status].glyph} ${s.id} ${s.title} ${s.percent}%`)
    }
  }
  lines.push(task.requirements.length ? 'Requirements:' : 'Requirements: (ninguno referenciado)')
  for (const r of task.requirements) {
    const item = spec.requirements[r]
    lines.push(`  ${r} — ${item ? item.text : 'no encontrado en requirements.md'}`)
  }
  const design = designFor(spec, task)
  lines.push(design.length ? 'Design:' : 'Design: (sin coincidencias)')
  for (const d of design) {
    lines.push(`  § ${d.heading.heading} (design.md:${d.heading.line}) ← ${d.via}`)
  }
  if (job) lines.push(`Última corrida: ${job.id} · ${job.status}${job.result ? ` · ${job.result}` : ''} · ${job.log}`)
  return lines.join('\n')
}

function summary(b: Board): string {
  if (b.error) return b.error
  return b.specs
    .map(s => {
      const rows = s.tasks
        .filter(t => !t.parentId)
        .map(t => {
          const pct = t.status === 'progress' ? ` ${t.percent}%` : ''
          return `${LIGHT[t.status].glyph} ${t.id} ${t.title}${pct}`
        })
      return [`spec ${s.name}: ${s.done}/${s.total} ✓ ${s.percent}%`, ...rows].join('\n')
    })
    .join('\n\n')
}

function jobsText(all: Jobs): string {
  const list = Object.values(all).sort((a, b) => b.started - a.started).slice(0, 15)
  if (list.length === 0) return `Sin corridas conocidas. Lanza una con /spec-board run <id> (bridge en ${config.bridge.url}).`
  return list
    .map(j => `${j.status === 'running' ? '⟳' : j.status === 'done' ? '✔' : '✖'} ${j.id} · ${j.status}${j.result ? ` · ${j.result}` : ''}`)
    .join('\n')
}

function touchesSpecs(e: { tool: string } & Record<string, unknown>): boolean {
  const path = typeof e.file_path === 'string' ? e.file_path : ''
  const command = typeof e.command === 'string' ? e.command : ''
  const hit = (s: string) => /\.kiro[\\/]specs|aidlc-state\.md/.test(s)
  return hit(path) || (e.tool === 'Bash' && hit(command))
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    config = await loadConfig($)
    await $.command.register({
      name: COMMAND,
      description:
        'Semáforo de tareas de Kiro: /spec-board [run|test <task> [here] | <task> | <task> <0-100> | <task> clear | jobs | bridge | refresh | publish | auto on|off]',
    })
    const fresh = await loadIfChanged($, true)
    if (fresh) {
      await update($, board, () => fresh)
      $.ui.status(statusLine(fresh))
    }
    if (e.isInteractive) void $.ui.open({ id: PANE, title: 'Spec board' })

    pollTimer?.cancel()
    pollTimer = $.clock.every(config.pollMs, () => {
      void (async () => {
        const changed = await loadIfChanged($, false)
        if (changed) {
          const before = await read($, board)
          await update($, board, () => changed)
          $.ui.status(statusLine(changed))
          await announce($, before, changed)
        }
        const known = await read($, jobs)
        if (!hasRunning(known)) return
        const polled = await pollJobs($, known)
        if (!polled) return
        await update($, jobs, () => polled.jobs)
        for (const job of polled.finished) $.ui.toast(jobToast(job))
      })().catch(() => undefined)
    })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const args = e.args.trim().split(/\s+/).filter(Boolean)
    const [first, second, third] = args

    const reload = async (): Promise<Board> => {
      config = await loadConfig($)
      const before = await read($, board)
      const fresh = await loadIfChanged($, true)
      if (fresh) {
        await update($, board, () => fresh)
        $.ui.status(statusLine(fresh))
        await announce($, before, fresh)
        return fresh
      }
      return before
    }

    if (!first || first === 'open') {
      const b = await reload()
      const opened = await $.ui.open({ id: PANE, title: 'Spec board' })
      return { text: opened.isPlaced ? (statusLine(b) ?? b.error) : summary(b) }
    }
    if (first === 'refresh') {
      const b = await reload()
      return { text: `Spec board actualizado. ${statusLine(b) ?? b.error ?? ''}` }
    }
    if (first === 'jobs') {
      const known = await read($, jobs)
      const polled = await pollJobs($, known)
      if (polled) {
        await update($, jobs, () => polled.jobs)
        return { text: jobsText(polled.jobs) }
      }
      return { text: `${jobsText(known)}\n(bridge no disponible en ${config.bridge.url})` }
    }
    if (first === 'bridge') {
      if (second === 'start') {
        const up = await ensureBridge($)
        return { text: up ? `Bridge arriba en ${config.bridge.url}.` : `No pude levantar el bridge. ${startHint()}.` }
      }
      const r = await bridgeGet($, '/health')
      if (r.ok && isRecord(r.json)) {
        const running = typeof r.json.running === 'number' ? r.json.running : 0
        return { text: `Bridge arriba en ${config.bridge.url} · spec ${String(r.json.spec ?? '')} · ${running} corrida(s) en curso · claude ${String(r.json.claude ?? '')}` }
      }
      return { text: `Bridge caído en ${config.bridge.url}. /spec-board bridge start lo levanta; o ${startHint()}.` }
    }
    if (first === 'auto') {
      if (second === 'on' || second === 'off') {
        await $.store.set(AUTO_REGEN_KEY, second === 'on')
        if (second === 'off') {
          regenTimer?.cancel()
          regenTimer = undefined
          pendingChanges = []
        }
        return { text: `Regeneración automática del dashboard local: ${second === 'on' ? 'activada' : 'desactivada'}.` }
      }
      const enabled = await $.store.get(AUTO_REGEN_KEY).catch(() => true)
      return {
        text: `Regeneración automática del dashboard local: ${enabled === false ? 'desactivada' : 'activada'} (/spec-board auto on|off). Sin turnos de modelo: data.js se regenera vía bridge o generador.`,
      }
    }
    if (first === 'publish') {
      await reload()
      if (!config.dashboard.artifactUrl) {
        return { text: `No hay dashboard.artifactUrl en ${CONFIG_FILE}; el dashboard local está en ${config.bridge.url}/board.` }
      }
      void $.prompt.submit({ text: publishPrompt() }).catch(() => undefined)
      return { text: `Encolada la publicación del Artifact (${config.dashboard.artifactUrl}). Esto sí gasta un turno.` }
    }

    const b = await read($, board)
    const isAction = first === 'run' || first === 'test'
    const wanted = (isAction ? second ?? '' : first).toLowerCase()
    const spec =
      b.specs.length === 1
        ? b.specs[0]
        : b.specs.find(s => s.tasks.some(t => t.id.toLowerCase() === wanted))
    const task = spec?.tasks.find(t => t.id.toLowerCase() === wanted)
    if (!spec || !task) {
      const ids = b.specs.flatMap(s => s.tasks.filter(t => !t.parentId).map(t => t.id))
      const asked = isAction ? second ?? '(falta el id)' : first
      return { text: `No encuentro la tarea "${asked}". Tareas: ${ids.join(', ')}` }
    }
    if (isAction) {
      await update($, selected, () => `${spec.name}/${task.id}`)
      if (third === 'here') {
        // Explicit opt-in: queue into this session (costs this session's context).
        void $.prompt.submit({ text: taskPrompt(spec, task, first) }).catch(() => undefined)
        return { text: `${first === 'test' ? 'Verificación' : 'Ejecución'} de ${task.id} encolada en esta sesión.` }
      }
      const launched = await launchJob($, task, first)
      if (launched.job) {
        const job = launched.job
        await update($, jobs, cur => ({ ...cur, [job.id]: job }))
      }
      return { text: launched.text }
    }

    const key = `${STORE_PREFIX}${spec.name}/${task.id}`
    if (second === 'clear') {
      await $.store.delete(key)
      await reload()
      return { text: `Progreso manual de ${task.id} borrado.` }
    }
    if (second !== undefined) {
      const pct = Number(second)
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        return { text: 'El porcentaje debe estar entre 0 y 100.' }
      }
      await $.store.set(key, pct)
      const fresh = await reload()
      const found = findTask(fresh, `${spec.name}/${task.id}`)
      return { text: `${task.id} → ${pct}% (${found?.task.status ?? 'progress'}).` }
    }
    await update($, selected, () => `${spec.name}/${task.id}`)
    const known = await read($, jobs)
    return { text: describe(spec, task, latestJobFor(known, task.id)) }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (touchesSpecs(e)) {
      void loadIfChanged($, true)
        .then(async fresh => {
          if (!fresh) return
          const before = await read($, board)
          await update($, board, () => fresh)
          $.ui.status(statusLine(fresh))
          await announce($, before, fresh)
        })
        .catch(() => undefined)
    }
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const b = await read($, board)
    const picked = await read($, selected)
    const known = await read($, jobs)
    const now = await $.clock.now()
    const width = Math.max(30, e.props.bodyColumns)

    if (b.specs.length === 0) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text dimColor>{b.error ?? 'Cargando specs…'}</Text>
        </Box>
      )
    }

    const detail = findTask(b, picked)
    const detailDesign = detail ? designFor(detail.spec, detail.task) : []
    const detailJob = detail ? latestJobFor(known, detail.task.id) : undefined
    const running = Object.values(known).filter(j => j.status === 'running').length

    const launch = (task: Task, mode: 'run' | 'test') => {
      void launchJob($, task, mode)
        .then(async launched => {
          if (launched.job) {
            const job = launched.job
            await update($, jobs, cur => ({ ...cur, [job.id]: job }))
          }
          $.ui.toast(launched.text)
        })
        .catch(() => undefined)
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        {b.specs.map(spec => (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold>
              {fit(`spec ${spec.name}`, width - 22)} {spec.done}/{spec.total} ✓ {spec.percent}%
            </Text>
            <Text dimColor>{bar(spec.percent, width - 2)}</Text>
            <Text dimColor>
              ● {spec.done} hechas  ◐ {spec.progress} en curso  ○ {spec.pending} pendientes
              {running > 0 ? `  ⟳ ${running} corriendo` : ''}
            </Text>
            {spec.phases.map(phase => (
              <Box flexDirection="column" marginTop={1}>
                <Text bold>
                  {fit(phase.name, width - 20)} {bar(phase.percent, 10)} {phase.percent}%
                </Text>
                {phase.taskIds.map(id => {
                  const task = spec.tasks.find(t => t.id === id)
                  if (!task) return null
                  const light = LIGHT[task.status]
                  const ref = `${spec.name}/${task.id}`
                  const isPicked = picked === ref
                  const pct = task.status === 'progress' ? ` ${task.percent}%` : ''
                  const more = task.requirements.length > 4 ? ',…' : ''
                  const reqs = task.requirements.length
                    ? `  [${task.requirements.slice(0, 4).join(',')}${more}]`
                    : ''
                  const chip = jobChip(latestJobFor(known, task.id), now)
                  const canRun = allowedByBridge(task.id)
                  const label = fit(`${task.id} ${task.title}${pct}${reqs}${chip}`, width - (canRun ? 12 : 4))
                  return (
                    <Box flexDirection="row">
                      <Text color={light.color}>{light.glyph} </Text>
                      <Button
                        key={`task:${ref}`}
                        plain
                        label={isPicked ? `▶ ${label}` : label}
                        onPress={() => {
                          void update($, selected, cur => (cur === ref ? null : ref))
                        }}
                      />
                      {canRun && (
                        <Button key={`run:${ref}`} plain label=" ▶" onPress={() => launch(task, 'run')} />
                      )}
                      {canRun && (
                        <Button key={`test:${ref}`} plain label=" ✓" onPress={() => launch(task, 'test')} />
                      )}
                    </Box>
                  )
                })}
              </Box>
            ))}
          </Box>
        ))}

        {detail && (
          <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
            <Text bold>
              {LIGHT[detail.task.status].glyph} {detail.task.id}{' '}
              {fit(detail.task.title, width - 30)} — {detail.task.percent}%
            </Text>
            <Text dimColor>tasks.md:{detail.task.line}</Text>
            {allowedByBridge(detail.task.id) && (
              <Box flexDirection="row">
                <Button key={`detail-run:${detail.task.id}`} label="▶ Ejecutar" onPress={() => launch(detail.task, 'run')} />
                <Text> </Text>
                <Button key={`detail-test:${detail.task.id}`} label="✓ Testear" onPress={() => launch(detail.task, 'test')} />
              </Box>
            )}
            {detailJob && (
              <Text wrap="truncate-end">
                {detailJob.status === 'running' ? '⟳' : detailJob.status === 'done' ? '✔' : '✖'} {detailJob.id} · {detailJob.status}
                {detailJob.result ? ` · ${fit(detailJob.result, width - 40)}` : ''}
              </Text>
            )}
            {detail.task.subtaskIds.length > 0 && <Text bold>Subtareas</Text>}
            {detail.task.subtaskIds.map(id => {
              const s = detail.spec.tasks.find(t => t.id === id)
              if (!s) return null
              return (
                <Text color={LIGHT[s.status].color}>
                  {LIGHT[s.status].glyph} {fit(`${s.id} ${s.title}`, width - 10)} {s.percent}%
                </Text>
              )
            })}
            <Text bold>Requirements</Text>
            {detail.task.requirements.length === 0 && <Text dimColor>ninguno referenciado</Text>}
            {detail.task.requirements.map(r => {
              const item = detail.spec.requirements[r]
              return (
                <Text wrap="truncate-end">
                  {r} — {item ? fit(item.text, width - 8 - r.length) : 'no encontrado'}
                </Text>
              )
            })}
            <Text bold>Design</Text>
            {detailDesign.length === 0 && <Text dimColor>sin coincidencias</Text>}
            {detailDesign.map(d => (
              <Text wrap="truncate-end">
                § {fit(d.heading.heading, width - 22)}{' '}
                <Text dimColor>
                  L{d.heading.line} ← {d.via}
                </Text>
              </Text>
            ))}
          </Box>
        )}

        {b.aidlc && <Text dimColor>AI-DLC · {fit(b.aidlc, width - 10)}</Text>}
        <Text dimColor>▶ ejecuta · ✓ testea (bridge) · /spec-board {'<id>'} 40 fija progreso · jobs · refresh</Text>
      </Box>
    )
  })
}

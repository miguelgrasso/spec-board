import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'spec-board',
  component: 'Pane',
  requestId: 'spec-board',
  props: {
    title: 'Spec board',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const RUN = { origin: { kind: 'sdk' }, presentation: { isFullscreen: false, columns: 80 } } as const

const TASKS = `# Implementation Plan: demo

## Phase A — Offline

- [x] A1. Scaffolding
  - _Requirements: 8.1_

- [ ] A2. BudgetGuard
  - _Requirements: 3.4_
  - [x] A2.1 Property test (P2)
    - **Validates: Requirements 3.4 — Correctness Property P2**
  - [ ] A2.2 Another test

## Phase B — Live

- [ ] B1. Bedrock run
  - _Requirements: 6.1_
`

const REQUIREMENTS = `# Requirements

### Requirement 3: Configs

#### Acceptance Criteria

1. THE Baseline SHALL apply defaults.
4. THE Budget Guard SHALL stop the swarm.

### Requirement 8: Structure

1. THE Project SHALL follow the structure.
`

const DESIGN = `# Design

## Components and Interfaces

### 3.2 BudgetGuard

text

## Correctness Properties

### Property 2: Budget Guard Threshold Monotonicity

**Validates: Requirements 3.4**
`

function files(on: On, extra: Record<string, string> = {}): void {
  const texts: Record<string, string> = {
    '.kiro/specs/demo/tasks.md': TASKS,
    '.kiro/specs/demo/requirements.md': REQUIREMENTS,
    '.kiro/specs/demo/design.md': DESIGN,
    ...extra,
  }
  on('fs.list', () => ({
    value: [{ name: 'demo', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }],
  }))
  // The engine may hand the hook a resolved path: match on the relative suffix.
  const lookup = (path: string): string | undefined => {
    const normal = path.replace(/\\/g, '/')
    const key = Object.keys(texts).find(k => normal === k || normal.endsWith('/' + k))
    return key === undefined ? undefined : texts[key]
  }
  on('fs.exists', (_, e) => ({ value: lookup(e.path) !== undefined }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_, e) => {
    const text = lookup(e.path)
    return text === undefined ? { deny: `missing: ${e.path}` } : { value: text }
  })
  on('ui.status', () => ({ value: undefined }))
  mock.clock(on)
  mock.store(on)
  on('command.register', () => ({ value: { command: 'spec-board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

test('the pane shows a semaphore per task with phase progress', async ($, on) => {
  files(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    const header = await ui.find({ type: 'Text', text: /spec demo/ })
    expect(header?.text).toContain('1/3')

    // A2 has one of two subtasks done and its own box unchecked: in progress, 50%.
    const a2 = await ui.find({ type: 'Button', text: /A2 BudgetGuard/ })
    expect(a2?.text).toContain('50%')
    expect(a2?.text).toContain('[3.4]')

    const phaseB = await ui.find({ type: 'Text', text: /Phase B/ })
    expect(phaseB?.text).toContain('0%')

    await ui.unmount()
  }
})

test('the command describes a task with its requirements and design', async ($, on) => {
  files(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: false })

  const ran = await $.command.run({ command: 'spec-board', args: 'A2', ...RUN })
  expect(ran.text).toContain('A2 BudgetGuard — progress 50%')
  expect(ran.text).toContain('3.4 — THE Budget Guard SHALL stop the swarm.')
  expect(ran.text).toContain('Property 2: Budget Guard Threshold Monotonicity')
  expect(ran.text).toContain('3.2 BudgetGuard')
})

test('a manual percentage marks a pending task as in progress', async ($, on) => {
  files(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: false })

  const ran = await $.command.run({ command: 'spec-board', args: 'B1 40', ...RUN })
  expect(ran.text).toContain('B1 → 40% (progress)')
})

// --- bridge -----------------------------------------------------------------

const CONFIG = JSON.stringify({
  spec: 'demo',
  bridge: { url: 'http://127.0.0.1:9999', autoStart: false },
})

const JOB = { id: 'A2-run-1', task: 'A2', mode: 'run', status: 'running', result: '', started: 1, finished: null, log: 'runs/A2-run-1.log' }

function bridge(on: On, up: boolean): string[] {
  const calls: string[] = []
  on('http.fetch', (_, e) => {
    calls.push(e.url)
    if (!up) return { deny: 'ECONNREFUSED' }
    const path = e.url.replace(/^https?:\/\/[^/]+/, '')
    const body = path.startsWith('/health')
      ? { ok: true, spec: 'demo', claude: 'claude.exe', running: 0 }
      : path.startsWith('/jobs.json')
        ? [{ ...JOB, status: 'done', result: 'HECHA — listo', finished: 2 }]
        : path.startsWith('/run?')
          ? JOB
          : { error: 'ruta' }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  on('ui.toast', () => ({ value: undefined }))
  return calls
}

test('run goes to the bridge and remembers the job', async ($, on) => {
  files(on, { '.claude/spec-board.json': CONFIG })
  const calls = bridge(on, true)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: false })

  const ran = await $.command.run({ command: 'spec-board', args: 'run A2', ...RUN })
  expect(ran.text).toContain('A2-run-1')
  expect(calls.some(u => u.startsWith('http://127.0.0.1:9999/run?task=A2&mode=run'))).toBe(true)

  const detail = await $.command.run({ command: 'spec-board', args: 'A2', ...RUN })
  expect(detail.text).toContain('Última corrida: A2-run-1 · running')

  const jobs = await $.command.run({ command: 'spec-board', args: 'jobs', ...RUN })
  expect(jobs.text).toContain('✔ A2-run-1 · done · HECHA — listo')
})

test('a task outside the bridge scope is not sent, and a down bridge is reported', async ($, on) => {
  files(on, { '.claude/spec-board.json': CONFIG })
  const calls = bridge(on, false)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: false })

  const b1 = await $.command.run({ command: 'spec-board', args: 'run B1', ...RUN })
  expect(b1.text).toContain('fuera del alcance del bridge')
  expect(calls.length).toBe(0)

  const a2 = await $.command.run({ command: 'spec-board', args: 'test A2', ...RUN })
  expect(a2.text).toContain('Bridge no disponible en http://127.0.0.1:9999')
})

test('the pane offers run and test buttons only for tasks in the bridge scope', async ($, on) => {
  files(on, { '.claude/spec-board.json': CONFIG })
  bridge(on, true)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'run:demo/A2' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'run:demo/B1' })).toBeUndefined()
  await ui.press({ key: 'run:demo/A2' })
  const jobs = await $.command.run({ command: 'spec-board', args: 'jobs', ...RUN })
  expect(jobs.text).toContain('A2-run-1')
  await ui.unmount()
})

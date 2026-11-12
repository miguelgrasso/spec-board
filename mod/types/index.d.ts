export type TaskStatus = 'done' | 'progress' | 'pending'

export type Task = {
  id: string
  title: string
  mark: string
  optional: boolean
  status: TaskStatus
  percent: number
  line: number
  phase: string
  parentId?: string
  subtaskIds: string[]
  requirements: string[]
  properties: string[]
  text: string
}

export type Phase = { name: string; short: string; taskIds: string[]; percent: number; done: number; progress: number; pending: number }

export type ReqItem = { id: string; title: string; text: string; line: number }

export type DesignHeading = { heading: string; line: number; level: number; validates: string[]; words: string[] }

export type SpecBoard = {
  name: string
  dir: string
  phases: Phase[]
  tasks: Task[]
  requirements: Record<string, ReqItem>
  design: DesignHeading[]
  done: number
  progress: number
  pending: number
  total: number
  percent: number
}

export type Board = { specs: SpecBoard[]; loadedAt: number; aidlc?: string; error?: string }

/** One bridge run (`claude -p` for a task), as `/jobs.json` reports it. */
export type JobStatus = 'running' | 'done' | 'failed' | 'dry'

export type Job = {
  id: string
  task: string
  mode: 'run' | 'test'
  status: JobStatus
  result: string
  started: number
  finished: number | null
  log: string
}

export type Jobs = Record<string, Job>

declare module 'claude-code' {
  interface PluginState {
    'spec-board': { board: Shaped<Board>; selected: string | null; jobs: Shaped<Jobs> }
  }
}

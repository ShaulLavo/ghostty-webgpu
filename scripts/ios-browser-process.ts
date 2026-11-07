import { spawn, type ChildProcess } from 'node:child_process'

export const nativeProcessLimits = Object.freeze({
  wallMs: 960000,
  interruptGraceMs: 12000,
}) satisfies ProcessLimits
export type ProcessLimits = { readonly wallMs: number; readonly interruptGraceMs: number }
export type NodeOutcome =
  | { kind: 'exited'; code: number | null; signal: NodeJS.Signals | null; joined: boolean }
  | {
      kind: 'failed'
      reason: 'spawn' | 'timeout' | 'interrupted' | 'descendants'
      detail: string
      joined: boolean
    }
type ProcessInput = { script: string; args: readonly string[]; cwd: string; signal: AbortSignal }
type FailedOutcome = Extract<NodeOutcome, { kind: 'failed' }>

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): string | null {
  if (pid === undefined) return null
  try {
    process.kill(-pid, signal)
    return null
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH')
      return null
    return String(error)
  }
}

function groupExists(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return !(
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ESRCH'
    )
  }
}

// Owns one Node process group, never a WebDriver session or framework protocol.
class JoinedNodeProcess {
  private readonly child: ChildProcess
  private readonly input: ProcessInput
  private readonly limits: ProcessLimits
  private readonly resolve: (outcome: NodeOutcome) => void
  private readonly wallTimer: ReturnType<typeof setTimeout>
  private interruptTimer: ReturnType<typeof setTimeout> | undefined
  private failure: FailedOutcome | undefined

  constructor(input: ProcessInput, limits: ProcessLimits, resolve: (outcome: NodeOutcome) => void) {
    this.input = input
    this.limits = limits
    this.resolve = resolve
    this.child = spawn(process.execPath, [input.script].concat(input.args), {
      cwd: input.cwd,
      stdio: 'inherit',
      detached: true,
    })
    this.wallTimer = setTimeout(this.onTimeout, limits.wallMs)
    input.signal.addEventListener('abort', this.onInterrupt, { once: true })
    this.child.once('error', this.onError)
    this.child.once('close', this.onClose)
  }

  private fail(reason: 'timeout' | 'interrupted', signal: NodeJS.Signals): void {
    this.failure ??= {
      kind: 'failed',
      reason,
      detail: `Owned Node process ${reason}`,
      joined: false,
    }
    const error = signalGroup(this.child.pid, signal)
    if (error) this.failure.detail = error
  }
  private onTimeout = () => {
    this.fail('timeout', 'SIGKILL')
  }
  private onInterrupt = () => {
    this.fail('interrupted', 'SIGTERM')
    this.interruptTimer ??= setTimeout(
      () => signalGroup(this.child.pid, 'SIGKILL'),
      this.limits.interruptGraceMs,
    )
  }
  private onError = (error: Error) => {
    this.failure = { kind: 'failed', reason: 'spawn', detail: String(error), joined: false }
  }
  private onClose = (code: number | null, signal: NodeJS.Signals | null) => {
    clearTimeout(this.wallTimer)
    clearTimeout(this.interruptTimer)
    this.input.signal.removeEventListener('abort', this.onInterrupt)
    const lingering = groupExists(this.child.pid)
    if (lingering) signalGroup(this.child.pid, 'SIGKILL')
    const joined = !groupExists(this.child.pid)
    if (this.failure) {
      this.resolve({ ...this.failure, joined })
      return
    }
    if (lingering) {
      this.resolve({
        kind: 'failed',
        reason: 'descendants',
        detail: 'Owned descendants survived the child',
        joined,
      })
      return
    }
    this.resolve({ kind: 'exited', code, signal, joined })
  }
}

export function runNodeProcess(
  input: ProcessInput,
  limits: ProcessLimits = nativeProcessLimits,
): Promise<NodeOutcome> {
  if (input.signal.aborted)
    return Promise.resolve({
      kind: 'failed',
      reason: 'interrupted',
      detail: 'Interrupted before child creation',
      joined: true,
    })
  return new Promise((resolve) => {
    new JoinedNodeProcess(input, limits, resolve)
  })
}

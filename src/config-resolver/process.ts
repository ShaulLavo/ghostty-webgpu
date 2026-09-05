import { spawn } from 'node:child_process'
import type { Readable } from 'node:stream'

import { NATIVE_OUTPUT_LIMIT_BYTES } from './schema.js'
import type { GhosttyConfigUnavailableReason } from './types.js'

export const RESOLVER_DEADLINE_MS = 2_000
export const RESOLVER_TERMINATION_GRACE_MS = 250

const ALLOWED_ENVIRONMENT = [
  'HOME',
  'CFFIXED_USER_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CONFIG_DIRS',
  'XDG_DATA_HOME',
  'XDG_DATA_DIRS',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
] as const

type TerminalCause = 'output-limit' | 'resolver-failed' | 'timeout'
type TimerToken = ReturnType<typeof setTimeout>

export type ResolverProcessOutcome =
  | { readonly bytes: Buffer; readonly kind: 'output' }
  | {
      readonly kind: 'unavailable'
      readonly reason: GhosttyConfigUnavailableReason
    }

export interface ResolverProcessInvocation {
  readonly abort?: AbortSignal
  readonly cwd: string
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly executable: string
  readonly resources: string
}

export interface ResolverChildProcess {
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  readonly stdout: Readable | null
  kill(signal: NodeJS.Signals): boolean
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  once(event: 'error', listener: (error: Error) => void): this
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
}

export interface ResolverSpawnOptions {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly shell: false
  readonly stdio: readonly ['ignore', 'pipe', 'ignore']
  readonly windowsHide: true
}

export interface ResolverProcessDependencies {
  readonly clearTimer: (token: TimerToken) => void
  readonly setTimer: (callback: () => void, milliseconds: number) => TimerToken
  readonly spawn: (
    executable: string,
    argv: readonly string[],
    options: ResolverSpawnOptions,
  ) => ResolverChildProcess
}

const DEFAULT_DEPENDENCIES: ResolverProcessDependencies = {
  clearTimer: clearTimeout,
  setTimer: setTimeout,
  spawn: (executable, argv, options) =>
    spawn(executable, [...argv], {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell,
      stdio: [...options.stdio],
      windowsHide: options.windowsHide,
    }),
}

export function resolverEnvironment(
  inherited: Readonly<Record<string, string | undefined>>,
  resources: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const name of ALLOWED_ENVIRONMENT) {
    const value = inherited[name]
    if (value === undefined) continue
    environment[name] = value
  }
  environment.GHOSTTY_RESOURCES_DIR = resources
  return environment
}

export function runResolverProcess(
  invocation: ResolverProcessInvocation,
  dependencies: ResolverProcessDependencies = DEFAULT_DEPENDENCIES,
): Promise<ResolverProcessOutcome> {
  let child: ResolverChildProcess
  try {
    child = dependencies.spawn(invocation.executable, [], {
      cwd: invocation.cwd,
      env: resolverEnvironment(invocation.environment, invocation.resources),
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
  } catch {
    return Promise.resolve(unavailable('resolver-failed'))
  }
  return new Promise((resolve) => {
    const controller = new ResolverProcessController(child, invocation.abort, dependencies, resolve)
    controller.start()
  })
}

class ResolverProcessController {
  private readonly chunks: Buffer[] = []
  private bytes = 0
  private cause: TerminalCause | null = null
  private closed = false
  private deadline: TimerToken | null = null
  private escalation: TimerToken | null = null
  private exited = false
  private settled = false

  constructor(
    private readonly child: ResolverChildProcess,
    private readonly abort: AbortSignal | undefined,
    private readonly dependencies: ResolverProcessDependencies,
    private readonly resolve: (outcome: ResolverProcessOutcome) => void,
  ) {}

  start(): void {
    this.child.once('error', this.onChildError)
    this.child.once('exit', this.onExit)
    this.child.once('close', this.onClose)
    this.abort?.addEventListener('abort', this.onAbort, { once: true })
    const stdout = this.child.stdout
    if (!stdout) {
      this.beginTermination('resolver-failed')
      return
    }
    stdout.on('data', this.onData)
    stdout.once('error', this.onStdoutError)
    if (this.abort?.aborted) {
      this.beginTermination('resolver-failed')
      return
    }
    this.deadline = this.dependencies.setTimer(
      () => this.beginTermination('timeout'),
      RESOLVER_DEADLINE_MS,
    )
  }

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.cause || this.settled) return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (this.bytes + bytes.length > NATIVE_OUTPUT_LIMIT_BYTES) {
      this.beginTermination('output-limit')
      return
    }
    this.bytes += bytes.length
    this.chunks.push(bytes)
  }

  private readonly onStdoutError = (): void => {
    this.beginTermination('resolver-failed')
  }

  private readonly onChildError = (): void => {
    if (this.exited || this.settled) return
    if (!this.cause) this.cause = 'resolver-failed'
    this.finish(unavailable(this.cause))
  }

  private readonly onAbort = (): void => {
    if (this.exited) return
    this.beginTermination('resolver-failed')
  }

  private readonly onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (this.settled) return
    this.exited = true
    if (!this.cause && (signal || (code !== null && code !== 0 && code !== 20))) {
      this.cause = 'resolver-failed'
      this.discardOutput()
    }
    this.clearDeadline()
    this.scheduleCloseFallback(code, signal)
  }

  private readonly onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    this.closed = true
    this.finishExit(code, signal)
  }

  private finishExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.cause) {
      this.finish(unavailable(this.cause))
      return
    }
    if (signal) {
      this.finish(unavailable('resolver-failed'))
      return
    }
    const output = Buffer.concat(this.chunks, this.bytes)
    if (code === 0) {
      this.finish({ bytes: output, kind: 'output' })
      return
    }
    if (code === 20 && output.length === 0) {
      this.finish(unavailable('config-not-found'))
      return
    }
    if (code === 20) {
      this.finish(unavailable('invalid-output'))
      return
    }
    this.finish(unavailable('resolver-failed'))
  }

  private scheduleCloseFallback(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.escalation !== null) this.dependencies.clearTimer(this.escalation)
    this.escalation = this.dependencies.setTimer(
      () => this.finishExit(code, signal),
      RESOLVER_TERMINATION_GRACE_MS,
    )
  }

  private beginTermination(cause: TerminalCause): void {
    if (this.cause || this.settled) return
    this.cause = cause
    this.discardOutput()
    if (this.closed || this.child.exitCode !== null || this.child.signalCode !== null) {
      this.finish(unavailable(cause))
      return
    }
    this.kill('SIGTERM')
    this.escalation = this.dependencies.setTimer(
      () => this.escalateTermination(),
      RESOLVER_TERMINATION_GRACE_MS,
    )
  }

  private escalateTermination(): void {
    if (this.closed || this.settled) return
    this.kill('SIGKILL')
    this.escalation = this.dependencies.setTimer(
      () => this.finish(unavailable(this.cause ?? 'resolver-failed')),
      RESOLVER_TERMINATION_GRACE_MS,
    )
  }

  private kill(signal: NodeJS.Signals): void {
    try {
      this.child.kill(signal)
    } catch {
      return
    }
  }

  private discardOutput(): void {
    this.chunks.length = 0
    this.bytes = 0
  }

  private finish(outcome: ResolverProcessOutcome): void {
    if (this.settled) return
    this.settled = true
    this.clearTimers()
    this.abort?.removeEventListener('abort', this.onAbort)
    this.resolve(outcome)
  }

  private clearTimers(): void {
    this.clearDeadline()
    if (this.escalation !== null) this.dependencies.clearTimer(this.escalation)
    this.escalation = null
  }

  private clearDeadline(): void {
    if (this.deadline !== null) this.dependencies.clearTimer(this.deadline)
    this.deadline = null
  }
}

function unavailable(reason: GhosttyConfigUnavailableReason): ResolverProcessOutcome {
  return { kind: 'unavailable', reason }
}

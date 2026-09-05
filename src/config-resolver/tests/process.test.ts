import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { NATIVE_OUTPUT_LIMIT_BYTES } from '../schema.js'
import {
  RESOLVER_DEADLINE_MS,
  RESOLVER_TERMINATION_GRACE_MS,
  resolverEnvironment,
  runResolverProcess,
  type ResolverChildProcess,
  type ResolverProcessDependencies,
  type ResolverSpawnOptions,
} from '../process.js'

class FakeChild extends EventEmitter implements ResolverChildProcess {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly stdout = new PassThrough()
  readonly signals: NodeJS.Signals[] = []

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal)
    return true
  }

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
    this.stdout.end()
    this.emit('close', code, signal)
  }
}

function harness(child = new FakeChild()): {
  readonly child: FakeChild
  readonly dependencies: ResolverProcessDependencies
  readonly options: () => ResolverSpawnOptions
} {
  let observed: ResolverSpawnOptions | null = null
  return {
    child,
    dependencies: {
      clearTimer: clearTimeout,
      setTimer: setTimeout,
      spawn: (_executable, argv, options) => {
        expect(argv).toEqual([])
        observed = options
        return child
      },
    },
    options: () => {
      if (!observed) throw new Error('spawn options unavailable')
      return observed
    },
  }
}

function invocation(abort?: AbortSignal) {
  return {
    abort,
    cwd: '/package',
    environment: {
      GHOSTTY_RESOURCES_DIR: '/attacker/resources',
      HOME: '/isolated/home',
      LANG: 'C.UTF-8',
      PATH: '/attacker/bin',
      PLAN066_SECRET: 'do-not-forward',
      XDG_CONFIG_HOME: '/isolated/config',
    },
    executable: '/package/native/bin/resolver',
    resources: '/package/native/resources',
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('resolverEnvironment', () => {
  it('copies only reviewed search/locale inputs and forces packaged resources', () => {
    expect(resolverEnvironment(invocation().environment, '/verified/resources')).toEqual({
      GHOSTTY_RESOURCES_DIR: '/verified/resources',
      HOME: '/isolated/home',
      LANG: 'C.UTF-8',
      XDG_CONFIG_HOME: '/isolated/config',
    })
  })
})

describe('runResolverProcess', () => {
  it('uses the fixed spawn policy and returns exit-zero bytes', async () => {
    const state = harness()
    const pending = runResolverProcess(invocation(), state.dependencies)
    state.child.stdout.write('{"ok":true}\n')
    state.child.close(0)

    await expect(pending).resolves.toEqual({ bytes: Buffer.from('{"ok":true}\n'), kind: 'output' })
    expect(state.options()).toEqual({
      cwd: '/package',
      env: {
        GHOSTTY_RESOURCES_DIR: '/package/native/resources',
        HOME: '/isolated/home',
        LANG: 'C.UTF-8',
        XDG_CONFIG_HOME: '/isolated/config',
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
  })

  it('maps the fixed exit protocol without exposing output', async () => {
    const missing = harness()
    const missingResult = runResolverProcess(invocation(), missing.dependencies)
    missing.child.close(20)
    await expect(missingResult).resolves.toEqual({
      kind: 'unavailable',
      reason: 'config-not-found',
    })

    const invalid = harness()
    const invalidResult = runResolverProcess(invocation(), invalid.dependencies)
    invalid.child.stdout.write('unexpected')
    invalid.child.close(20)
    await expect(invalidResult).resolves.toEqual({ kind: 'unavailable', reason: 'invalid-output' })

    const failure = harness()
    const failureResult = runResolverProcess(invocation(), failure.dependencies)
    failure.child.stdout.write('PLAN066_SECRET_SENTINEL')
    failure.child.close(21)
    await expect(failureResult).resolves.toEqual({
      kind: 'unavailable',
      reason: 'resolver-failed',
    })
  })

  it('allows exactly 128 KiB and terminates on the first byte over the cap', async () => {
    const exact = harness()
    const exactResult = runResolverProcess(invocation(), exact.dependencies)
    exact.child.stdout.write(Buffer.alloc(NATIVE_OUTPUT_LIMIT_BYTES))
    exact.child.close(0)
    await expect(exactResult).resolves.toMatchObject({
      bytes: expect.objectContaining({ length: NATIVE_OUTPUT_LIMIT_BYTES }),
      kind: 'output',
    })

    const overflow = harness()
    const overflowResult = runResolverProcess(invocation(), overflow.dependencies)
    overflow.child.stdout.write(Buffer.alloc(NATIVE_OUTPUT_LIMIT_BYTES + 1))
    expect(overflow.child.signals).toEqual(['SIGTERM'])
    overflow.child.close(null, 'SIGTERM')
    await expect(overflowResult).resolves.toEqual({ kind: 'unavailable', reason: 'output-limit' })
  })

  it('bounds timeout cleanup with TERM then KILL and keeps the first cause', async () => {
    vi.useFakeTimers()
    const state = harness()
    const pending = runResolverProcess(invocation(), state.dependencies)

    await vi.advanceTimersByTimeAsync(RESOLVER_DEADLINE_MS)
    expect(state.child.signals).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(RESOLVER_TERMINATION_GRACE_MS)
    expect(state.child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    await vi.advanceTimersByTimeAsync(RESOLVER_TERMINATION_GRACE_MS)
    await expect(pending).resolves.toEqual({ kind: 'unavailable', reason: 'timeout' })
  })

  it('bounds a missing close event and does not signal an already-exited child', async () => {
    vi.useFakeTimers()
    const state = harness()
    const pending = runResolverProcess(invocation(), state.dependencies)

    await vi.advanceTimersByTimeAsync(RESOLVER_DEADLINE_MS)
    state.child.exitCode = 21
    state.child.emit('exit', 21, null)
    await vi.advanceTimersByTimeAsync(RESOLVER_TERMINATION_GRACE_MS)

    expect(state.child.signals).toEqual(['SIGTERM'])
    await expect(pending).resolves.toEqual({ kind: 'unavailable', reason: 'timeout' })
  })

  it('keeps a natural exit ahead of a later private abort race', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const state = harness()
    const pending = runResolverProcess(invocation(controller.signal), state.dependencies)
    state.child.stdout.write('{"ok":true}\n')
    state.child.exitCode = 0
    state.child.emit('exit', 0, null)
    controller.abort()
    state.child.emit('error', new Error('late child error'))
    await vi.advanceTimersByTimeAsync(RESOLVER_TERMINATION_GRACE_MS)

    expect(state.child.signals).toEqual([])
    await expect(pending).resolves.toEqual({ bytes: Buffer.from('{"ok":true}\n'), kind: 'output' })
  })

  it('terminates a spawned child whose stdout pipe is unexpectedly absent', async () => {
    vi.useFakeTimers()
    const signals: NodeJS.Signals[] = []
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: (signal: NodeJS.Signals) => {
        signals.push(signal)
        return true
      },
      signalCode: null,
      stdout: null,
    }) as unknown as ResolverChildProcess
    const state = harness()
    const pending = runResolverProcess(invocation(), {
      ...state.dependencies,
      spawn: () => child,
    })

    expect(signals).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(RESOLVER_TERMINATION_GRACE_MS)
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    await vi.advanceTimersByTimeAsync(RESOLVER_TERMINATION_GRACE_MS)
    await expect(pending).resolves.toEqual({
      kind: 'unavailable',
      reason: 'resolver-failed',
    })
  })

  it('uses bounded termination for a private abort and settles once', async () => {
    const controller = new AbortController()
    const state = harness()
    const pending = runResolverProcess(invocation(controller.signal), state.dependencies)
    controller.abort()
    expect(state.child.signals).toEqual(['SIGTERM'])
    state.child.close(null, 'SIGTERM')
    state.child.emit('error', new Error('late error'))
    await expect(pending).resolves.toEqual({
      kind: 'unavailable',
      reason: 'resolver-failed',
    })
  })

  it('reduces synchronous and asynchronous spawn failures to a fixed reason', async () => {
    const thrown = harness()
    const dependencies: ResolverProcessDependencies = {
      ...thrown.dependencies,
      spawn: () => {
        throw new Error('/private/path must not escape')
      },
    }
    await expect(runResolverProcess(invocation(), dependencies)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'resolver-failed',
    })

    const emitted = harness()
    const pending = runResolverProcess(invocation(), emitted.dependencies)
    emitted.child.emit('error', new Error('PLAN066_SECRET_SENTINEL'))
    await expect(pending).resolves.toEqual({ kind: 'unavailable', reason: 'resolver-failed' })
  })
})

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '../../dom/terminal.js'
import { ExtensionManager } from '../manager.js'
import type { Contributions, Extension, TerminalInputEvent } from '../types.js'

let terminal: Terminal
let manager: ExtensionManager
let errors: unknown[]

beforeAll(async () => {
  terminal = await Terminal.create()
})

afterAll(() => terminal.dispose())

beforeEach(() => {
  errors = []
  manager = new ExtensionManager({
    terminal,
    reservedOsc: new Set(),
    onError: (cause) => errors.push(cause),
  })
})

afterEach(() => {
  manager.dispose()
  expect(errors).toEqual([])
  vi.restoreAllMocks()
})

const inputs: readonly TerminalInputEvent[] = [
  { type: 'key', input: { action: 'press', code: 'KeyA', composing: false, text: 'a' } },
  { type: 'paste', data: 'pasted' },
  { type: 'composition', text: '界' },
  { type: 'text', data: 'text' },
]

function installSentinels(count: number) {
  const counters = { setups: 0, extensionReads: 0, contributionReads: 0 }
  let armed = false
  const contributions = new Proxy<Contributions>(
    {},
    {
      get(target, key, receiver) {
        if (armed) counters.contributionReads += 1
        return Reflect.get(target, key, receiver)
      },
      ownKeys(target) {
        if (armed) counters.contributionReads += 1
        return Reflect.ownKeys(target)
      },
    },
  )
  const values = Array.from(
    { length: count },
    (_, index) =>
      new Proxy<Extension>(
        {
          name: `inert-${index}`,
          setup: () => {
            counters.setups += 1
            return contributions
          },
        },
        {
          get(target, key, receiver) {
            if (armed) counters.extensionReads += 1
            return Reflect.get(target, key, receiver)
          },
          ownKeys(target) {
            if (armed) counters.extensionReads += 1
            return Reflect.ownKeys(target)
          },
        },
      ),
  )
  manager.install(values)
  expect(counters.setups).toBe(count)
  counters.setups = 0
  armed = true
  return { counters, values }
}

describe('manager-only extension cost gates', () => {
  it.each([0, 100, 1_000])('X1/X2 dispatch touches zero inert values at count %i', (count) => {
    const { counters } = installSentinels(count)
    const payloads = { frame: 0, data: 0, resize: 0, osc: 0 }
    for (let operation = 0; operation < 100; operation += 1) {
      for (const input of inputs) expect(manager.dispatchInput(input)).toBe(false)
      manager.emit('frame', () => {
        payloads.frame += 1
        return { rows: [0, 1] }
      })
      manager.emit('data', () => {
        payloads.data += 1
        return new Uint8Array([97])
      })
      manager.emit('resize', () => {
        payloads.resize += 1
        return { cols: 80, rows: 24 }
      })
      manager.observeOsc(7400, () => {
        payloads.osc += 1
        return { number: 7400, payload: 'observed', terminator: 'st', truncated: false }
      })
    }
    expect(counters).toEqual({ setups: 0, extensionReads: 0, contributionReads: 0 })
    expect(payloads).toEqual({ frame: 0, data: 0, resize: 0, osc: 0 })
  })

  it('sentinel counters detect direct value and contribution reads', () => {
    const { counters, values } = installSentinels(1)
    expect(values[0]!.name).toBe('inert-0')
    const contributions = values[0]!.setup({
      terminal,
      signal: new AbortController().signal,
      own: () => {},
    })
    expect(contributions.input).toBeUndefined()
    expect(counters).toEqual({ setups: 1, extensionReads: 2, contributionReads: 1 })
  })

  it.each([10, 100, 1_000])(
    'X4 runs exactly %i passing handlers amid 1,000 inert values',
    (count) => {
      const { counters } = installSentinels(1_000)
      let calls = 0
      let observed: TerminalInputEvent | undefined
      const handles = Array.from({ length: count }, (_, index) =>
        manager.use({
          name: `passing-${index}`,
          setup: () => ({
            input: (input) => {
              calls += 1
              observed = input
              return 'pass'
            },
          }),
        }),
      )
      for (const input of inputs) {
        expect(manager.dispatchInput(input)).toBe(false)
        expect(observed).toBe(input)
      }
      expect(calls).toBe(count * inputs.length)
      for (const handle of handles) handle.dispose()
      expect(manager.hasInput).toBe(false)
      for (const input of inputs) expect(manager.dispatchInput(input)).toBe(false)
      expect(calls).toBe(count * inputs.length)
      expect(counters).toEqual({ setups: 0, extensionReads: 0, contributionReads: 0 })
    },
  )

  it('claiming positive control stops the next interested input handler', () => {
    installSentinels(1_000)
    let claims = 0
    let passing = 0
    manager.use({
      name: 'claim',
      setup: () => ({
        input: () => {
          claims += 1
          return 'claim'
        },
      }),
    })
    manager.use({
      name: 'pass',
      setup: () => ({
        input: () => {
          passing += 1
          return 'pass'
        },
      }),
    })
    for (const input of inputs) expect(manager.dispatchInput(input)).toBe(true)
    expect(claims).toBe(inputs.length)
    expect(passing).toBe(0)
  })

  it('X7 keeps AbortControllers lazy until a scope signal is requested', () => {
    const controllers = vi.spyOn(globalThis, 'AbortController')
    installSentinels(1_000)
    expect(controllers).not.toHaveBeenCalled()
    let signal: AbortSignal | undefined
    const handle = manager.use({
      name: 'signal',
      setup: (scope) => {
        signal = scope.signal
        expect(scope.signal).toBe(signal)
        return {}
      },
    })
    expect(controllers).toHaveBeenCalledOnce()
    expect(signal?.aborted).toBe(false)
    handle.dispose()
    expect(signal?.aborted).toBe(true)
    expect(controllers).toHaveBeenCalledOnce()
  })

  it('X5 builds each subscribed payload once and stops building after detach', () => {
    const { counters } = installSentinels(1_000)
    const calls = { frame: 0, data: 0, resize: 0, osc: 0 }
    const payloads = { frame: 0, data: 0, resize: 0, osc: 0 }
    const attach = (name: string) =>
      manager.use({
        name,
        setup: () => ({
          events: {
            frame: () => {
              calls.frame += 1
            },
            data: () => {
              calls.data += 1
            },
            resize: () => {
              calls.resize += 1
            },
          },
        }),
      })
    const first = attach('first')
    const second = attach('second')
    const osc = manager.use({
      name: 'osc',
      setup: () => ({
        osc: {
          7400: () => {
            calls.osc += 1
          },
        },
      }),
    })
    const emit = () => {
      manager.emit('frame', () => {
        payloads.frame += 1
        return { rows: [0, 1] }
      })
      manager.emit('data', () => {
        payloads.data += 1
        return new Uint8Array([97])
      })
      manager.emit('resize', () => {
        payloads.resize += 1
        return { cols: 80, rows: 24 }
      })
      manager.observeOsc(7400, () => {
        payloads.osc += 1
        return { number: 7400, payload: 'observed', terminator: 'st', truncated: false }
      })
    }
    emit()
    expect(calls).toEqual({ frame: 2, data: 2, resize: 2, osc: 1 })
    expect(payloads).toEqual({ frame: 1, data: 1, resize: 1, osc: 1 })
    first.dispose()
    emit()
    expect(calls).toEqual({ frame: 3, data: 3, resize: 3, osc: 2 })
    expect(payloads).toEqual({ frame: 2, data: 2, resize: 2, osc: 2 })
    second.dispose()
    osc.dispose()
    emit()
    expect(calls).toEqual({ frame: 3, data: 3, resize: 3, osc: 2 })
    expect(payloads).toEqual({ frame: 2, data: 2, resize: 2, osc: 2 })
    expect(counters).toEqual({ setups: 0, extensionReads: 0, contributionReads: 0 })
  })
})

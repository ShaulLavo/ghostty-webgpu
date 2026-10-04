import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '../../index.js'
import { createLinkLineSnapshot } from '../../term/links.js'
import type { LinkProvider } from '../../term/links.js'
import { ExtensionManager } from '../manager.js'
import type {
  Extension,
  ExtensionHandle,
  ExtensionInput,
  ExtensionScope,
  TerminalInputEvent,
} from '../types.js'

let terminal: Terminal
let manager: ExtensionManager
let errors: { cause: unknown; operation: string }[]

beforeAll(async () => {
  terminal = await Terminal.create()
})

afterAll(() => terminal.dispose())

beforeEach(() => {
  errors = []
  manager = new ExtensionManager({
    terminal,
    reservedOsc: new Set([0, 2, 8, 52, 133]),
    onError: (cause, operation) => errors.push({ cause, operation }),
  })
})

afterEach(() => {
  manager.dispose()
  vi.restoreAllMocks()
})

const textInput: TerminalInputEvent = { type: 'text', data: 'a' }

function inert(name: string): Extension {
  return { name, setup: () => ({}) }
}

describe('extension attachment', () => {
  it('returns the required typed API and gives setup the public terminal', () => {
    const api = { read: () => 'line' }
    const extension: Extension<typeof api> = {
      name: 'reader',
      setup: (scope) => {
        expect(scope.terminal).toBe(terminal)
        return { api }
      },
    }
    const handle = manager.use(extension)
    expect(handle.api).toBe(api)
    expect(handle.api.read()).toBe('line')
  })

  it('flattens nested readonly presets in encounter order', () => {
    const calls: number[] = []
    const extension = (number: number): Extension => ({
      name: String(number),
      setup: () => ({
        input: () => {
          calls.push(number)
          return 'pass'
        },
      }),
    })
    const preset: readonly ExtensionInput[] = [extension(1), [extension(2), [extension(3)]]]
    manager.install(preset)
    manager.use(extension(4))
    expect(manager.dispatchInput(textInput)).toBe(false)
    expect(calls).toEqual([1, 2, 3, 4])
  })

  it('rejects duplicate identity while allowing equal diagnostic names', () => {
    const first = inert('same-name')
    manager.use(first)
    expect(() => manager.use(first)).toThrow('already attached')
    expect(() => manager.use(inert('same-name'))).not.toThrow()
  })

  it('reserves identity before setup, preventing recursive duplicate attachment', () => {
    const extension: Extension = {
      name: 'recursive',
      setup: () => {
        manager.use(extension)
        return {}
      },
    }
    expect(() => manager.use(extension)).toThrow('already attached')
    expect(errors).toHaveLength(1)
    expect(manager.hasInput).toBe(false)
  })

  it('allows one value on multiple terminals and starts fresh state after detach', async () => {
    const otherTerminal = await Terminal.create()
    const other = new ExtensionManager({
      terminal: otherTerminal,
      reservedOsc: new Set(),
      onError: vi.fn(),
    })
    let count = 0
    const extension: Extension<number> = { name: 'counter', setup: () => ({ api: ++count }) }
    try {
      const first = manager.use(extension)
      const second = other.use(extension)
      expect([first.api, second.api]).toEqual([1, 2])
      first.dispose()
      expect(manager.use(extension).api).toBe(3)
    } finally {
      other.dispose()
      otherTerminal.dispose()
    }
  })

  it('disposes attachments and their owned cleanup in reverse order exactly once', () => {
    const calls: string[] = []
    const extension = (name: string): Extension => ({
      name,
      setup: (scope) => {
        scope.own(() => calls.push(`${name}:1`))
        scope.own(() => calls.push(`${name}:2`))
        return {}
      },
    })
    const first = manager.use(extension('first'))
    const second = manager.use(extension('second'))
    manager.dispose()
    first.dispose()
    second.dispose()
    manager.dispose()
    expect(calls).toEqual(['second:2', 'second:1', 'first:2', 'first:1'])
  })

  it('unindexes every contribution before aborting its scope', () => {
    const command = vi.fn()
    const provider = { provideLinks: () => undefined }
    let signal: AbortSignal | undefined
    const handle = manager.use({
      name: 'all-hooks',
      setup: (scope) => {
        signal = scope.signal
        signal.addEventListener('abort', () => {
          expect(manager.hasInput).toBe(false)
          expect(manager.hasEvent('title')).toBe(false)
          expect(manager.hasOsc(7400)).toBe(false)
          expect(manager.command('run')).toBeUndefined()
          const links = vi.fn()
          manager.visitLinks(links)
          expect(links).not.toHaveBeenCalled()
        })
        return {
          input: () => 'pass',
          events: { title: vi.fn() },
          osc: { 7400: vi.fn() },
          commands: { run: command },
          links: provider,
        }
      },
    })
    handle.dispose()
    expect(signal?.aborted).toBe(true)
  })

  it('preserves a fresh same-value attachment created while the old scope aborts', () => {
    let sequence = 0
    let replacement: ExtensionHandle<number> | undefined
    const cleanup = vi.fn()
    const extension: Extension<number> = {
      name: 'reattach-on-abort',
      setup: (scope) => {
        const api = ++sequence
        scope.own(cleanup)
        if (api === 1) {
          scope.signal.addEventListener('abort', () => {
            replacement = manager.use(extension)
          })
        }
        return { api, input: () => 'claim' }
      },
    }
    const first = manager.use(extension)
    first.dispose()
    first.dispose()
    expect(first.api).toBe(1)
    expect(replacement?.api).toBe(2)
    expect(manager.dispatchInput(textInput)).toBe(true)
    expect(() => manager.use(extension)).toThrow('already attached')
    expect(cleanup).toHaveBeenCalledOnce()
    replacement?.dispose()
    expect(manager.hasInput).toBe(false)
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(manager.use(extension).api).toBe(3)
  })

  it('allows inert, input-only and empty OSC values without native OSC capability', () => {
    manager.dispose()
    manager = new ExtensionManager({
      terminal,
      onError: (cause, operation) => errors.push({ cause, operation }),
    })
    manager.install([
      inert('inert'),
      { name: 'input', setup: () => ({ input: () => 'claim' }) },
      { name: 'empty-osc', setup: () => ({ osc: {} }) },
    ])
    expect(manager.dispatchInput(textInput)).toBe(true)
    expect(errors).toEqual([])
  })

  it('rejects unavailable OSC before publishing any contribution and permits same-value retry', () => {
    manager.dispose()
    manager = new ExtensionManager({
      terminal,
      onError: (cause, operation) => errors.push({ cause, operation }),
    })
    const cleanup = vi.fn()
    const aborted = vi.fn()
    const callback = vi.fn()
    let unavailable = true
    const extension: Extension = {
      name: 'capability',
      setup: (scope) => {
        scope.own(cleanup)
        scope.signal.addEventListener('abort', aborted, { once: true })
        return {
          input: () => 'claim',
          events: { bell: callback },
          commands: { run: callback },
          links: { provideLinks: callback },
          osc: unavailable ? { 777: callback } : undefined,
        }
      },
    }
    expect(() => manager.use(extension)).toThrow('Custom OSC observation is unavailable')
    expect(cleanup).toHaveBeenCalledOnce()
    expect(aborted).toHaveBeenCalledOnce()
    expect(manager.hasInput).toBe(false)
    expect(manager.hasEvent('bell')).toBe(false)
    expect(manager.hasOsc(777)).toBe(false)
    expect(manager.command('run')).toBeUndefined()
    manager.visitLinks((provider) => provider.provideLinks(createLinkLineSnapshot([]), 0))
    manager.emit('bell', () => undefined)
    expect(callback).not.toHaveBeenCalled()
    unavailable = false
    const handle = manager.use(extension)
    expect(manager.dispatchInput(textInput)).toBe(true)
    handle.dispose()
    handle.dispose()
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(aborted).toHaveBeenCalledTimes(2)
  })

  it('rolls back throwing setup and permits another attachment of the same value', () => {
    const failure = new TypeError('setup failed')
    const calls: number[] = []
    let scope: ExtensionScope | undefined
    let fail = true
    const extension: Extension = {
      name: 'failing',
      setup: (value) => {
        scope = value
        value.own(() => calls.push(1))
        value.own(() => calls.push(2))
        if (fail) throw failure
        return { input: () => 'claim' }
      },
    }
    expect(() => manager.use(extension)).toThrow(failure)
    expect(scope?.signal.aborted).toBe(true)
    expect(calls).toEqual([2, 1])
    expect(manager.hasInput).toBe(false)
    expect(errors).toEqual([{ cause: failure, operation: 'extension.setup' }])
    fail = false
    manager.use(extension)
    expect(manager.dispatchInput(textInput)).toBe(true)
  })

  it('rolls back only the new preset when one nested extension fails', () => {
    const existing = vi.fn()
    manager.use({ name: 'existing', setup: () => ({ events: { bell: existing } }) })
    const cleanup = vi.fn()
    const added: Extension = {
      name: 'added',
      setup: (scope) => {
        scope.own(cleanup)
        return { input: () => 'claim' }
      },
    }
    const failing: Extension = {
      name: 'failed',
      setup: () => {
        throw new TypeError('failed')
      },
    }
    expect(() => manager.install([added, [failing]])).toThrow('failed')
    expect(cleanup).toHaveBeenCalledOnce()
    expect(manager.hasInput).toBe(false)
    manager.emit('bell', () => undefined)
    expect(existing).toHaveBeenCalledOnce()
    expect(() => manager.use(added)).not.toThrow()
  })

  it('continues cleanup after a failure even if the error sink throws', () => {
    const owned = vi.fn()
    const local = new ExtensionManager({
      terminal,
      reservedOsc: new Set(),
      onError: () => {
        throw new TypeError('sink')
      },
    })
    const handle = local.use({
      name: 'cleanup',
      setup: (scope) => {
        scope.own(owned)
        scope.own(() => {
          throw new TypeError('cleanup')
        })
        return {}
      },
    })
    expect(() => handle.dispose()).not.toThrow()
    expect(owned).toHaveBeenCalledOnce()
    local.dispose()
  })

  it('cleans resources registered after disposal immediately', () => {
    let scope: ExtensionScope | undefined
    const handle = manager.use({
      name: 'late',
      setup: (value) => {
        scope = value
        return {}
      },
    })
    handle.dispose()
    const cleanup = vi.fn()
    scope!.own(cleanup)
    expect(cleanup).toHaveBeenCalledOnce()
    expect(scope!.signal.aborted).toBe(true)
  })

  it('does not resurrect an attachment when the manager is disposed during setup', () => {
    const cleanup = vi.fn()
    expect(() =>
      manager.use({
        name: 'shutdown',
        setup: (scope) => {
          scope.own(cleanup)
          manager.dispose()
          return { input: () => 'claim' }
        },
      }),
    ).toThrow('disposed')
    expect(cleanup).toHaveBeenCalledOnce()
    expect(manager.hasInput).toBe(false)
    expect(() => manager.use(inert('after-shutdown'))).toThrow('disposed')
  })

  it.each(['OSC', 'command', 'OSC and command'])(
    'rejects a reentrant provider getter that acquires the outer %s ownership',
    (conflict) => {
      const cleanup = vi.fn()
      const observer = vi.fn()
      const command = vi.fn()
      const provideLinks = vi.fn(() => undefined)
      let inner: ExtensionHandle | undefined
      let signal: AbortSignal | undefined
      const getter = vi.fn(() => {
        inner = manager.use({
          name: 'inner',
          setup: () => ({ osc: { 7400: observer }, commands: { run: command } }),
        })
        return provideLinks
      })
      const provider = {
        get provideLinks() {
          return getter()
        },
      }
      expect(() =>
        manager.use({
          name: 'outer',
          setup: (scope) => {
            signal = scope.signal
            scope.own(cleanup)
            return {
              input: () => 'claim',
              events: { title: vi.fn() },
              links: provider,
              osc: conflict === 'command' ? undefined : { 7400: vi.fn() },
              commands: conflict === 'OSC' ? undefined : { run: vi.fn() },
            }
          },
        }),
      ).toThrow('already has an owner')
      expect(getter).toHaveBeenCalledOnce()
      expect(cleanup).toHaveBeenCalledOnce()
      expect(signal?.aborted).toBe(true)
      expect(manager.hasInput).toBe(false)
      expect(manager.hasEvent('title')).toBe(false)
      const links = vi.fn()
      manager.visitLinks(links)
      expect(links).not.toHaveBeenCalled()
      const payload = {
        number: 7400,
        payload: 'inner',
        terminator: 'st' as const,
        truncated: false,
      }
      manager.observeOsc(7400, () => payload)
      expect(observer).toHaveBeenCalledExactlyOnceWith(payload)
      expect(manager.command('run')).toBe(command)
      manager.command('run')!()
      expect(command).toHaveBeenCalledOnce()
      expect(errors).toHaveLength(1)
      expect(errors[0]?.operation).toBe('extension.setup')
      expect(inner).toBeDefined()
      inner!.dispose()
      expect(manager.hasOsc(7400)).toBe(false)
      expect(manager.command('run')).toBeUndefined()
    },
  )

  it('does not publish hooks after a contribution getter disposes the manager', () => {
    expect(() =>
      manager.use({
        name: 'getter',
        setup: () => ({
          get api() {
            manager.dispose()
            return undefined
          },
          input: () => 'claim',
        }),
      }),
    ).toThrow('disposed')
    expect(manager.hasInput).toBe(false)
  })
})

describe('interested-only hook indexes', () => {
  it('stops input dispatch at the first claim and resumes after detach', () => {
    const calls: string[] = []
    const extension = (name: string, decision: 'claim' | 'pass'): Extension => ({
      name,
      setup: () => ({
        input: () => {
          calls.push(name)
          return decision
        },
      }),
    })
    manager.use(extension('pass', 'pass'))
    const claim = manager.use(extension('claim', 'claim'))
    manager.use(extension('later', 'claim'))
    expect(manager.dispatchInput(textInput)).toBe(true)
    expect(calls).toEqual(['pass', 'claim'])
    calls.length = 0
    claim.dispose()
    expect(manager.dispatchInput(textInput)).toBe(true)
    expect(calls).toEqual(['pass', 'later'])
  })

  it('broadcasts one payload only to subscribers of that event', () => {
    const first = vi.fn()
    const second = vi.fn()
    const bell = vi.fn()
    manager.use({ name: 'first', setup: () => ({ events: { title: first, bell } }) })
    manager.use({ name: 'second', setup: () => ({ events: { title: second } }) })
    const payload = vi.fn(() => 'title')
    manager.emit('title', payload)
    expect(payload).toHaveBeenCalledOnce()
    expect(first).toHaveBeenCalledExactlyOnceWith('title')
    expect(second).toHaveBeenCalledExactlyOnceWith('title')
    expect(bell).not.toHaveBeenCalled()
  })

  it('broadcasts even when a void handler returns the string claim', () => {
    const second = vi.fn()
    manager.use({ name: 'first', setup: () => ({ events: { title: () => 'claim' } }) })
    manager.use({ name: 'second', setup: () => ({ events: { title: second } }) })
    manager.emit('title', () => 'title')
    expect(second).toHaveBeenCalledOnce()
  })

  it('never builds event or OSC payloads without matching subscriptions', () => {
    const frame = vi.fn(() => ({ rows: [0] }))
    const osc = vi.fn(() => ({
      number: 7400,
      payload: 'data',
      terminator: 'st' as const,
      truncated: false,
    }))
    manager.emit('frame', frame)
    manager.observeOsc(7400, osc)
    expect(frame).not.toHaveBeenCalled()
    expect(osc).not.toHaveBeenCalled()
    const handle = manager.use({ name: 'different-osc', setup: () => ({ osc: { 7401: vi.fn() } }) })
    manager.observeOsc(7400, osc)
    expect(osc).not.toHaveBeenCalled()
    handle.dispose()
    expect(manager.hasOsc(7401)).toBe(false)
  })

  it('rejects duplicate or reserved OSC owners transactionally', () => {
    const original = vi.fn()
    manager.use({ name: 'original', setup: () => ({ osc: { 7400: original } }) })
    const cleanup = vi.fn()
    expect(() =>
      manager.use({
        name: 'duplicate',
        setup: (scope) => {
          scope.own(cleanup)
          return {
            input: () => 'claim',
            events: { frame: vi.fn() },
            osc: { 7399: vi.fn(), 7400: vi.fn() },
          }
        },
      }),
    ).toThrow('already has an owner')
    expect(cleanup).toHaveBeenCalledOnce()
    expect(manager.hasInput).toBe(false)
    expect(manager.hasEvent('frame')).toBe(false)
    expect(manager.hasOsc(7399)).toBe(false)
    expect(() =>
      manager.use({ name: 'reserved', setup: () => ({ osc: { 52: vi.fn() } }) }),
    ).toThrow('already has an owner')
    const payload = {
      number: 7400,
      payload: 'custom',
      terminator: 'bel' as const,
      truncated: false,
    }
    manager.observeOsc(7400, () => payload)
    expect(original).toHaveBeenCalledExactlyOnceWith(payload)
  })

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid OSC number %s', (number) => {
    expect(() =>
      manager.use({ name: 'bad-osc', setup: () => ({ osc: { [number]: vi.fn() } }) }),
    ).toThrow('safe integer')
  })

  it('rejects command conflicts before publishing other contributions', () => {
    const command = vi.fn()
    const first = manager.use({ name: 'first', setup: () => ({ commands: { run: command } }) })
    expect(() =>
      manager.use({
        name: 'second',
        setup: () => ({ input: () => 'claim', osc: { 7400: vi.fn() }, commands: { run: vi.fn() } }),
      }),
    ).toThrow('already has an owner')
    expect(manager.hasInput).toBe(false)
    expect(manager.hasOsc(7400)).toBe(false)
    expect(manager.command('run')).toBe(command)
    first.dispose()
    expect(manager.command('run')).toBeUndefined()
    expect(() =>
      manager.use({ name: 'replacement', setup: () => ({ commands: { run: vi.fn() } }) }),
    ).not.toThrow()
  })

  it('visits link providers in attachment order and removes them on detach', () => {
    const first = { provideLinks: () => undefined }
    const second = { provideLinks: () => undefined }
    const handle = manager.use({ name: 'first', setup: () => ({ links: first }) })
    manager.use({ name: 'second', setup: () => ({ links: second }) })
    const providers: unknown[] = []
    manager.visitLinks((provider) => providers.push(provider))
    expect(providers).toEqual([first, second])
    providers.length = 0
    handle.dispose()
    manager.visitLinks((provider) => providers.push(provider))
    expect(providers).toEqual([second])
  })

  it('disposes a late host registration once without resurrecting any contribution', () => {
    const provider = { provideLinks: () => undefined }
    const dispose = vi.fn()
    const cleanup = vi.fn()
    const hostErrors = vi.fn()
    let local!: ExtensionManager
    const registerLinkProvider = vi.fn((actual: LinkProvider<Event>) => {
      expect(actual).toBe(provider)
      local.dispose()
      return { token: Symbol('host-link'), dispose }
    })
    local = new ExtensionManager({ terminal, registerLinkProvider, onError: hostErrors })
    let signal!: AbortSignal
    expect(() =>
      local.use({
        name: 'late-host-links',
        setup: (scope) => {
          signal = scope.signal
          scope.own(cleanup)
          return {
            links: provider,
            input: () => 'claim',
            events: { title: vi.fn() },
            commands: { linked: vi.fn() },
          }
        },
      }),
    ).toThrow('disposed')
    expect(registerLinkProvider).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(signal.aborted).toBe(true)
    const visit = vi.fn()
    local.visitLinks(visit)
    expect(visit).not.toHaveBeenCalled()
    expect(local.hasInput).toBe(false)
    expect(local.hasEvent('title')).toBe(false)
    expect(local.command('linked')).toBeUndefined()
    local.dispose()
    local.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(hostErrors).toHaveBeenCalledTimes(1)
  })

  it('reports handler errors and continues broadcast or input arbitration', async () => {
    const failure = new TypeError('handler failed')
    manager.use({
      name: 'throwing',
      setup: () => ({
        input: () => {
          throw failure
        },
        events: {
          title: async () => {
            throw failure
          },
        },
      }),
    })
    const title = vi.fn()
    manager.use({ name: 'working', setup: () => ({ input: () => 'claim', events: { title } }) })
    expect(manager.dispatchInput(textInput)).toBe(true)
    manager.emit('title', () => 'title')
    await Promise.resolve()
    expect(title).toHaveBeenCalledOnce()
    expect(errors).toEqual([
      { cause: failure, operation: 'extension.input' },
      { cause: failure, operation: 'extension.event' },
    ])
  })

  it.each([100, 1000])(
    'keeps %s inert attachments out of dispatch and avoids resource allocation',
    (count) => {
      const controller = vi.spyOn(globalThis, 'AbortController')
      const setup = vi.fn(() => ({}))
      const values = Array.from({ length: count }, (_, index) => ({ name: String(index), setup }))
      manager.install(values)
      expect(setup).toHaveBeenCalledTimes(count)
      const input = vi.fn(() => 'pass' as const)
      const interested = manager.use({ name: 'input', setup: () => ({ input }) })
      const frame = vi.fn(() => ({ rows: [] }))
      const osc = vi.fn(() => ({
        number: 7400,
        payload: '',
        terminator: 'st' as const,
        truncated: false,
      }))
      const iterators = [
        vi.spyOn(Map.prototype, 'values'),
        vi.spyOn(Map.prototype, 'entries'),
        vi.spyOn(Map.prototype, Symbol.iterator),
      ]
      manager.dispatchInput(textInput)
      manager.dispatchInput({ type: 'paste', data: 'paste' })
      manager.dispatchInput({ type: 'composition', text: '文' })
      manager.emit('frame', frame)
      manager.observeOsc(7400, osc)
      const extra = manager.use(inert('extra'))
      extra.dispose()
      interested.dispose()
      manager.dispose()
      const iterationCounts = iterators.map((iterator) => iterator.mock.calls.length)
      iterators.forEach((iterator) => iterator.mockRestore())
      expect(iterationCounts).toEqual([0, 0, 0])
      expect(input).toHaveBeenCalledTimes(3)
      expect(setup).toHaveBeenCalledTimes(count)
      expect(frame).not.toHaveBeenCalled()
      expect(osc).not.toHaveBeenCalled()
      expect(controller).not.toHaveBeenCalled()
    },
  )

  it.each([100, 1000])(
    'reattaches one identity without rebuilding its index beside %s inert attachments',
    (count) => {
      manager.install(Array.from({ length: count }, (_, index) => inert(String(index))))
      let sequence = 0
      const target: Extension<number> = {
        name: 'target',
        setup: () => ({ api: ++sequence }),
      }
      const first = manager.use(target)
      first.dispose()
      const mutations = [
        vi.spyOn(Map.prototype, 'set'),
        vi.spyOn(Map.prototype, 'delete'),
        vi.spyOn(WeakMap.prototype, 'set'),
        vi.spyOn(WeakMap.prototype, 'delete'),
      ]
      const apis: number[] = []
      for (let index = 0; index < 100; index += 1) {
        const handle = manager.use(target)
        first.dispose()
        apis.push(handle.api)
        handle.dispose()
      }
      const identityMutations = mutations.map(
        (mutation) => mutation.mock.calls.filter(([key]) => key === target).length,
      )
      mutations.forEach((mutation) => mutation.mockRestore())
      expect(identityMutations).toEqual([0, 0, 0, 0])
      expect(first.api).toBe(1)
      expect(apis).toEqual(Array.from({ length: 100 }, (_, index) => index + 2))
      expect(() => manager.use(target)).not.toThrow()
    },
  )

  it.each([10, 100, 1000])('visits exactly %s interested passing handlers', (count) => {
    let calls = 0
    for (let index = 0; index < count; index += 1) {
      manager.use({
        name: String(index),
        setup: () => ({
          input: () => {
            calls += 1
            return 'pass'
          },
        }),
      })
    }
    const arrayCopy = vi.spyOn(Array, 'from')
    expect(manager.dispatchInput(textInput)).toBe(false)
    expect(calls).toBe(count)
    expect(arrayCopy).not.toHaveBeenCalled()
  })
})

describe('reentrant indexed dispatch', () => {
  it('skips a detached successor without losing the rest of the list', () => {
    const calls: string[] = []
    let second: ExtensionHandle
    manager.use({
      name: 'first',
      setup: () => ({
        events: {
          bell: () => {
            calls.push('first')
            second.dispose()
          },
        },
      }),
    })
    second = manager.use({
      name: 'second',
      setup: () => ({ events: { bell: () => calls.push('second') } }),
    })
    manager.use({ name: 'third', setup: () => ({ events: { bell: () => calls.push('third') } }) })
    manager.emit('bell', () => undefined)
    expect(calls).toEqual(['first', 'third'])
  })

  it('excludes new subscribers even when the original tail is detached', () => {
    const calls: string[] = []
    let tail: ExtensionHandle
    const newcomer: Extension = {
      name: 'new',
      setup: () => ({ events: { bell: () => calls.push('new') } }),
    }
    let changed = false
    manager.use({
      name: 'first',
      setup: () => ({
        events: {
          bell: () => {
            calls.push('first')
            if (changed) return
            changed = true
            tail.dispose()
            manager.use(newcomer)
          },
        },
      }),
    })
    manager.use({ name: 'middle', setup: () => ({ events: { bell: () => calls.push('middle') } }) })
    tail = manager.use({
      name: 'tail',
      setup: () => ({ events: { bell: () => calls.push('tail') } }),
    })
    manager.emit('bell', () => undefined)
    expect(calls).toEqual(['first', 'middle'])
    calls.length = 0
    manager.emit('bell', () => undefined)
    expect(calls).toEqual(['first', 'middle', 'new'])
  })

  it('keeps independent boundaries for a nested event dispatch', () => {
    const calls: string[] = []
    let nested = false
    manager.use({
      name: 'first',
      setup: () => ({
        events: {
          title: () => {
            calls.push('first')
            if (nested) return
            nested = true
            manager.emit('title', () => 'nested')
          },
        },
      }),
    })
    manager.use({
      name: 'second',
      setup: () => ({ events: { title: () => calls.push('second') } }),
    })
    manager.emit('title', () => 'outer')
    expect(calls).toEqual(['first', 'first', 'second', 'second'])
  })

  it('stops visiting subscribers when a handler disposes the manager', () => {
    const later = vi.fn()
    manager.use({ name: 'shutdown', setup: () => ({ events: { bell: () => manager.dispose() } }) })
    manager.use({ name: 'later', setup: () => ({ events: { bell: later } }) })
    manager.emit('bell', () => undefined)
    expect(later).not.toHaveBeenCalled()
    expect(manager.hasEvent('bell')).toBe(false)
  })
})

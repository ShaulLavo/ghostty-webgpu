import { expect } from 'vitest'
import type { RunnerTaskResultPack } from 'vitest'
import type { FrameworkObservation } from 'waffle/testing/page-runner/framework-page'
import { getFrameworkObservation } from 'waffle/testing/page-runner/framework-page'
import { errorJson } from './ios-browser-records.ts'
import { inReportingRealm, payload, rejected, until } from './ios-browser-reporting-realm.ts'

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}
function pairedObservation(): FrameworkObservation {
  const observation = getFrameworkObservation()
  if (!observation) throw new Error('Missing real paired observation')
  return observation
}
function withOriginalUpdate(
  rpc: (this: unknown, ...args: unknown[]) => unknown,
  use: (
    invoke: (packs: readonly RunnerTaskResultPack[], events: unknown[]) => unknown,
    receiver: object,
  ) => void,
): void {
  const worker: unknown = Reflect.get(globalThis, '__vitest_worker__')
  const browser: unknown = Reflect.get(globalThis, '__vitest_browser_runner__')
  if (!object(worker) || !object(worker.rpc) || !object(browser) || !object(browser.runner))
    throw new Error('Missing actual installed runner')
  const runner = browser.runner
  const update = runner.onTaskUpdate
  if (typeof update !== 'function') throw new Error('Missing actual installed update hook')
  const original = worker.rpc
  const proxy = new Proxy(original, {
    get(target, key, receiver) {
      return key === 'onTaskUpdate' ? rpc : Reflect.get(target, key, receiver)
    },
  })
  worker.rpc = proxy
  try {
    use((packs, events) => Reflect.apply(update, runner, [packs, events]), proxy)
  } finally {
    worker.rpc = original
  }
}
async function reentry(
  category: keyof Pick<
    FrameworkObservation,
    'collected' | 'taskStarted' | 'taskUpdate' | 'caseSettled' | 'error'
  >,
): Promise<void> {
  await inReportingRealm(async ({ observation, snapshot }) => {
    let reads = 0
    let nested: Promise<void> | undefined
    const invoke = {
      collected: () =>
        observation.collected(() => {
          reads++
          return []
        }),
      taskStarted: () =>
        observation.taskStarted(() => {
          reads++
          return 'nested'
        }),
      taskUpdate: () =>
        observation.taskUpdate(() => {
          reads++
          return []
        }),
      caseSettled: () =>
        observation.caseSettled(() => {
          reads++
          return null
        }),
      error: () =>
        observation.error(() => {
          reads++
          return { error: null, source: 'nested' }
        }),
    }
    const outer = observation.error(() => {
      nested = invoke[category]()
      observeSyntheticRejection(nested)
      return { error: 'outer', source: 'synthetic' }
    })
    await rejected(outer)
    if (!nested) throw new Error('Missing nested reporting call')
    await rejected(nested)
    expect(reads).toBe(0)
    expect(snapshot().ackedThrough).toBe(0)
    expect(snapshot().pending).toBe(0)
    expect(snapshot().failure).toContain('reentry')
  })
}
function observeSyntheticRejection(promise: Promise<void>): void {
  void promise.catch(() => {})
}
function reenteringEncoder(
  observation: FrameworkObservation,
  entered: () => void,
): typeof TextEncoder {
  return class extends TextEncoder {
    override encode(input?: string): Uint8Array<ArrayBuffer> {
      entered()
      observeSyntheticRejection(observation.taskUpdate(() => []))
      return super.encode(input)
    }
  }
}
async function withCapturedClocks(child: Window, action: () => Promise<void>): Promise<void> {
  const timer: unknown = Reflect.get(child, 'setTimeout')
  const clock: unknown = Reflect.get(child, 'performance')
  if (!object(clock)) throw new Error('Missing actual realm clock')
  const previous = Object.getOwnPropertyDescriptor(clock, 'now')
  const calls: string[] = []
  Reflect.set(child, 'setTimeout', () => {
    calls.push('timeout')
    throw new Error('uncaptured timer')
  })
  Reflect.set(clock, 'now', () => {
    calls.push('now')
    return 0
  })
  try {
    await action()
    expect(calls).toEqual([])
  } finally {
    Reflect.set(child, 'setTimeout', timer)
    if (previous) Object.defineProperty(clock, 'now', previous)
    else Reflect.deleteProperty(clock, 'now')
  }
}
async function prefix(control: 'capacity' | 'conversion' | 'last-slot'): Promise<void> {
  const gate = Promise.withResolvers<void>()
  const accepted: unknown[] = []
  let hold = false
  let refusedReads = 0
  await inReportingRealm(
    async ({ observation, snapshot }) => {
      hold = true
      const count = control === 'conversion' ? 1 : 64
      const operations = Array.from({ length: count }, (_, index) =>
        observation.error(() => {
          if (index === 63) expect(snapshot().pending).toBe(64)
          return { error: index, source: 'synthetic-prefix' }
        }),
      )
      const refusal = observation.error(() => {
        refusedReads++
        if (control === 'conversion') throw new Error('synthetic conversion refusal')
        return { error: 'unadmitted', source: 'synthetic-prefix' }
      })
      await rejected(refusal)
      expect(refusedReads).toBe(control === 'conversion' ? 1 : 0)
      expect(observation.signal.aborted).toBe(true)
      expect(snapshot().pending).toBe(count)
      gate.resolve()
      const outcomes = await Promise.allSettled(operations)
      expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true)
      expect(accepted).toHaveLength(count)
      expect(snapshot().pending).toBe(0)
      expect(snapshot().ackedThrough).toBe(count)
      expect(snapshot().failure).not.toBeNull()
    },
    async (_url, init) => {
      const body = payload(init)
      if (hold) {
        accepted.push(body)
        await gate.promise
      }
      return Response.json({ ackedThrough: body.seq })
    },
    gate.resolve,
  )
}

export const reportingSyntheticCases = [
  {
    name: '01 actual installed body and collection',
    run: async () => {
      expect(pairedObservation().signal.aborted).toBe(false)
    },
  },
  {
    name: '02 original update promise is returned directly',
    run: async () => {
      const original = Promise.resolve('original')
      withOriginalUpdate(
        () => original,
        (invoke) => expect(invoke([], [])).toBe(original),
      )
    },
  },
  {
    name: '03 original update falsy results remain exact',
    run: async () => {
      for (const value of [0, false, '', null, undefined])
        withOriginalUpdate(
          () => value,
          (invoke) => expect(invoke([], [])).toBe(value),
        )
    },
  },
  {
    name: '04 update does not read an original then getter',
    run: async () => {
      let reads = 0
      const original = {
        // oxlint-disable-next-line unicorn/no-thenable -- Deliberate original thenable fixture.
        get then() {
          reads++
          throw new Error('must not observe original then')
        },
      }
      withOriginalUpdate(
        () => original,
        (invoke) => {
          expect(invoke([], [])).toBe(original)
          expect(reads).toBe(0)
        },
      )
    },
  },
  {
    name: '05 synchronous original throw stays falsy',
    run: async () => {
      let caught: { reason: unknown } | undefined
      withOriginalUpdate(
        () => {
          throw 0
        },
        (invoke) => {
          try {
            invoke([], [])
          } catch (reason) {
            caught = { reason }
          }
        },
      )
      expect(caught).toEqual({ reason: 0 })
    },
  },
  {
    name: '06 update retains original receiver and argument identities',
    run: async () => {
      const packs: RunnerTaskResultPack[] = []
      const events: unknown[] = []
      let received: unknown[] = []
      const receipt: { receiver?: unknown } = {}
      withOriginalUpdate(
        function (...args) {
          received = args
          receipt.receiver = this
          return false
        },
        (invoke, expected) => {
          expect(invoke(packs, events)).toBe(false)
          expect(receipt.receiver).toBe(expected)
          expect(received[0]).toBe('run')
          expect(received[1]).toBe(packs)
          expect(received[2]).toBe(events)
        },
      )
    },
  },
  {
    name: '07 held original RPC does not join reporting',
    run: async () => {
      const gate = Promise.withResolvers<void>()
      try {
        withOriginalUpdate(
          () => gate.promise,
          (invoke) => expect(invoke([], [])).toBe(gate.promise),
        )
        expect(pairedObservation().signal.aborted).toBe(false)
      } finally {
        gate.resolve()
        await gate.promise
      }
    },
  },
  {
    name: '08 paired null settlement creates no event',
    run: async () => {
      const bridge = window.__waffleFramework
      if (!bridge) throw new Error('Missing paired bridge')
      const before = bridge.snapshot().pending
      await pairedObservation().caseSettled(() => null)
      expect(bridge.snapshot().pending).toBe(before)
    },
  },
  {
    name: '09 factory runs synchronously after reservation',
    run: async () => {
      await inReportingRealm(async ({ observation, snapshot }) => {
        let captured = false
        const promise = observation.taskUpdate(() => {
          expect(snapshot().pending).toBe(1)
          captured = true
          return []
        })
        expect(captured).toBe(true)
        await promise
      })
    },
  },
  {
    name: '10 capacity 65 is failed incomplete with healthy prefix draining',
    run: () => prefix('capacity'),
  },
  {
    name: '11 throwing conversion consumes no sequence',
    run: async () => {
      await inReportingRealm(async ({ observation, snapshot }) => {
        await rejected(
          observation.error(() => ({
            error: errorJson({
              get broken() {
                throw null
              },
            }),
            source: 'getter',
          })),
        )
        expect(snapshot().ackedThrough).toBe(0)
        expect(snapshot().pending).toBe(0)
      })
    },
  },
  {
    name: '12 error getters are read once',
    run: async () => {
      let reads = 0
      await inReportingRealm(async ({ observation }) => {
        await observation.error(() => ({
          error: errorJson({
            get message() {
              reads++
              return 'once'
            },
          }),
          source: 'getter',
        }))
        expect(reads).toBe(1)
      })
    },
  },
  {
    name: '13 immutable full-envelope retry bytes',
    run: async () => {
      let eventCalls = 0
      let reads = 0
      const bodies: string[] = []
      await inReportingRealm(
        async ({ observation, window: child }) => {
          await withCapturedClocks(child, () =>
            observation.error(() => ({
              error: errorJson({
                get message() {
                  reads++
                  return `read ${reads}`
                },
              }),
              source: 'retry',
            })),
          )
          expect(reads).toBe(1)
          expect(bodies).toHaveLength(2)
          expect(bodies[0]).toBe(bodies[1])
        },
        async (_url, init) => {
          const body = payload(init)
          if (body.kind === 'event') {
            bodies.push(String(init.body))
            eventCalls++
          }
          return Response.json({
            ackedThrough: body.kind === 'event' && eventCalls === 1 ? -1 : body.seq,
          })
        },
      )
    },
  },
  {
    name: '14 snapshot null releases its reservation',
    run: async () => {
      await inReportingRealm(async ({ observation, snapshot }) => {
        let pending = -1
        await observation.caseSettled(() => {
          pending = snapshot().pending
          return null
        })
        expect(pending).toBe(1)
        expect(snapshot().pending).toBe(0)
        expect(snapshot().ackedThrough).toBe(0)
      })
    },
  },
  {
    name: '15 original update rejection keeps false',
    run: async () => {
      const original = Promise.reject(false)
      void original.catch(() => {})
      withOriginalUpdate(
        () => original,
        (invoke) => expect(invoke([], [])).toBe(original),
      )
      expect((await rejected(original)).reason).toBe(false)
    },
  },
  {
    name: '16 original thenable is read only by its real await owner',
    run: async () => {
      let reads = 0
      const original = {
        // oxlint-disable-next-line unicorn/no-thenable -- Deliberate original thenable fixture.
        get then() {
          reads++
          return (resolve: (value: string) => void) => resolve('settled')
        },
      }
      withOriginalUpdate(
        () => original,
        (invoke) => {
          expect(invoke([], [])).toBe(original)
          expect(reads).toBe(0)
        },
      )
      expect(await original).toBe('settled')
      expect(reads).toBe(1)
    },
  },
  { name: '17 last slot includes the active factory', run: () => prefix('last-slot') },
  { name: '18 collected factory reentry is refused', run: () => reentry('collected') },
  { name: '19 task-start factory reentry is refused', run: () => reentry('taskStarted') },
  { name: '20 update factory reentry is refused', run: () => reentry('taskUpdate') },
  { name: '21 settlement factory reentry is refused', run: () => reentry('caseSettled') },
  { name: '22 error factory reentry is refused', run: () => reentry('error') },
  {
    name: '23 encoding toJSON reentry cannot commit outer event',
    run: async () => {
      await inReportingRealm(async ({ observation, snapshot }) => {
        let nested: Promise<void> | undefined
        const error = Object.defineProperty({ value: 'synthetic' }, 'toJSON', {
          value() {
            nested = observation.taskUpdate(() => [])
            observeSyntheticRejection(nested)
            return 'encoded'
          },
        })
        await rejected(observation.error(() => ({ error, source: 'toJSON' })))
        expect(snapshot().ackedThrough).toBe(0)
      })
    },
  },
  {
    name: '24 final encoding rejects reentry or uses a captured encoder',
    run: async () => {
      await inReportingRealm(async ({ observation, window: child, snapshot }) => {
        const NativeEncoder = Reflect.get(child, 'TextEncoder')
        if (typeof NativeEncoder !== 'function') throw new Error('Missing realm encoder')
        let entries = 0
        Reflect.set(
          child,
          'TextEncoder',
          reenteringEncoder(observation, () => entries++),
        )
        try {
          const outcome = await observation
            .error(() => ({ error: 'encoding', source: 'encoder' }))
            .then(
              () => 'fulfilled',
              () => 'rejected',
            )
          expect(outcome).toBe(entries === 0 ? 'fulfilled' : 'rejected')
          expect(snapshot().ackedThrough).toBe(entries === 0 ? 1 : 0)
        } finally {
          Reflect.set(child, 'TextEncoder', NativeEncoder)
        }
      })
    },
  },
  {
    name: '25 captured timeout is not replaced by fixture globals',
    run: async () => {
      await inReportingRealm(async ({ observation, window: child }) => {
        const signal: unknown = Reflect.get(child, 'AbortSignal')
        if (typeof signal !== 'function') throw new Error('Missing realm AbortSignal')
        const original: unknown = Reflect.get(signal, 'timeout')
        let calls = 0
        Reflect.set(signal, 'timeout', () => {
          calls++
          throw new Error('uncaptured timeout')
        })
        try {
          await observation.taskUpdate(() => [])
          expect(calls).toBe(0)
        } finally {
          Reflect.set(signal, 'timeout', original)
        }
      })
    },
  },
  {
    name: '26 captured abort composition is not replaced by fixture globals',
    run: async () => {
      await inReportingRealm(async ({ observation, window: child }) => {
        const signal: unknown = Reflect.get(child, 'AbortSignal')
        if (typeof signal !== 'function') throw new Error('Missing realm AbortSignal')
        const original: unknown = Reflect.get(signal, 'any')
        if (typeof original !== 'function') throw new Error('Missing native abort composition')
        let calls = 0
        Reflect.set(signal, 'any', (...args: unknown[]) => {
          calls++
          return Reflect.apply(original, signal, args)
        })
        try {
          await observation.taskUpdate(() => [])
          expect(calls).toBe(0)
        } finally {
          Reflect.set(signal, 'any', original)
        }
      })
    },
  },
  {
    name: '27 conversion refusal preserves an admitted healthy prefix',
    run: () => prefix('conversion'),
  },
  {
    name: '28 closed reporting never reads another error snapshot',
    run: async () => {
      await inReportingRealm(async ({ observation }) => {
        await rejected(
          observation.error(() => {
            throw ''
          }),
        )
        let reads = 0
        await rejected(
          observation.error(() => {
            reads++
            return { error: null, source: 'closed' }
          }),
        )
        expect(reads).toBe(0)
      })
    },
  },
  {
    name: '29 declared case and hook clocks are unchanged',
    run: async () => {
      const state: unknown = Reflect.get(globalThis, '__vitest_worker__')
      if (!object(state) || !object(state.config)) throw new Error('Missing original config')
      expect(state.config.testTimeout).toBe(15000)
      expect(state.config.hookTimeout).toBe(30000)
    },
  },
  {
    name: '30 original elapsed body clock runs normally',
    run: async () => {
      const start = performance.now()
      await new Promise((resolve) => setTimeout(resolve, 12))
      expect(performance.now() - start).toBeGreaterThanOrEqual(10)
    },
  },
  {
    name: '31 synchronous execution closure precedes delivery',
    run: async () => {
      await inReportingRealm(async ({ observation, snapshot }) => {
        const closing = observation.executionFlushed()
        expect(snapshot().contentClosed).toBe(true)
        await closing
      })
    },
  },
  {
    name: '32 synchronous tester cleanup closure precedes delivery',
    run: async () => {
      await inReportingRealm(async ({ observation, snapshot }) => {
        const closing = observation.testerCleanupSettled()
        expect(snapshot().contentClosed).toBe(true)
        await closing
      })
    },
  },
  {
    name: '33 real throttle can report while a body is running',
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 140))
      expect(pairedObservation().signal.aborted).toBe(false)
    },
  },
  {
    name: '34 top cleanup delivery and retirement are distinct',
    run: async () => {
      await inReportingRealm(async ({ observation, snapshot, window: child }) => {
        const closing = observation.cleanupResponseReceived()
        expect(snapshot().contentClosed).toBe(true)
        await closing
        let retired = false
        const retirement = observation.waitForRetirement().then(() => {
          retired = true
        })
        await Promise.resolve()
        expect(retired).toBe(false)
        expect(child.__waffleFramework?.cutoff(snapshot().ackedThrough)).toBe(true)
        await retirement
        expect(retired).toBe(true)
      })
    },
  },
  {
    name: '35 finite nested sibling one',
    group: 'nested',
    run: async () => {
      expect(1).toBe(1)
    },
  },
  {
    name: '36 finite nested sibling two',
    group: 'nested',
    run: async () => {
      expect(2).toBe(2)
    },
  },
  {
    name: '37 concurrent sibling one',
    group: 'concurrent',
    run: async () => {
      await concurrentSibling()
    },
  },
  {
    name: '38 concurrent sibling two',
    group: 'concurrent',
    run: async () => {
      await concurrentSibling()
    },
  },
] satisfies { name: string; group?: 'nested' | 'concurrent'; run: () => Promise<void> }[]

let entered = 0
async function concurrentSibling(): Promise<void> {
  entered++
  await until(() => entered === 2)
  expect(entered).toBe(2)
}

import { expect, it } from 'vitest'
import type { WorkerCleanup, WorkerObservation } from './fixtures/worker-protocol.js'
import { WorkerRunCollector } from './fixtures/worker-run.js'

const observation: WorkerObservation = {
  globalType: '[object DedicatedWorkerGlobalScope]',
  windowType: 'undefined',
  fontLoaded: true,
  glyphInk: true,
  text: 'worker native\ndirect-port-output',
  cursor: { x: 18, y: 1, pendingWrap: false, visible: true },
  key: [97],
  paste: [],
  metrics: {
    zigFrames: 1,
    atlasCacheHits: 0,
    atlasCacheMisses: 1,
    atlasEvictions: 0,
    atlasPages: 1,
    atlasUploadedBytes: 4,
    atlasUploadOperations: 1,
    deviceRestores: 0,
    draws: 1,
    instanceUploadOperations: 1,
    rebuiltRows: 4,
    submittedFrames: 1,
    uploadedBytes: 4,
  },
  animationFrames: 1,
}
const cleanup: WorkerCleanup = {
  framesBeforeDispose: 1,
  timersBeforeDispose: 1,
  frames: 0,
  timers: 0,
  fontRemoved: true,
  outputClosed: true,
  sessionDisposed: true,
  backendReleased: true,
}
const producer = { type: 'sent', bufferDetached: true } as const
const error = 'Injected worker failure after native frame'

type EventType = 'result' | 'disposed' | 'producer' | 'error' | 'complete'

const orders: readonly {
  readonly name: string
  readonly signal: 'error' | 'complete'
  readonly events: readonly EventType[]
}[] = [
  {
    name: 'error before cleanup',
    signal: 'error',
    events: ['producer', 'result', 'error', 'disposed'],
  },
  {
    name: 'cleanup before error',
    signal: 'error',
    events: ['producer', 'result', 'disposed', 'error'],
  },
  {
    name: 'error before result',
    signal: 'error',
    events: ['producer', 'error', 'result', 'disposed'],
  },
  {
    name: 'producer after error and cleanup',
    signal: 'error',
    events: ['error', 'result', 'disposed', 'producer'],
  },
  {
    name: 'completion after observations',
    signal: 'complete',
    events: ['producer', 'result', 'disposed', 'complete'],
  },
  {
    name: 'producer after completion',
    signal: 'complete',
    events: ['result', 'disposed', 'complete', 'producer'],
  },
]

it.each(orders)('settles only after all required arrivals: $name', ({ signal, events }) => {
  const collector = new WorkerRunCollector(signal)
  const deliver: Record<EventType, () => void> = {
    result: () => collector.recordMessage({ type: 'result', observation }),
    disposed: () => collector.recordMessage({ type: 'disposed', cleanup }),
    producer: () => collector.recordProducer(producer),
    error: () => collector.recordError(error),
    complete: () => collector.recordMessage({ type: 'complete' }),
  }
  for (const event of events.slice(0, -1)) {
    deliver[event]()
    expect(collector.result()).toBeUndefined()
  }
  deliver[events.at(-1)!]()
  expect(collector.result()).toMatchObject({
    observation,
    cleanup,
    producer,
    error: signal === 'error' ? error : undefined,
  })
})

it('requires the frame result even when producer, cleanup and error have arrived', () => {
  const collector = new WorkerRunCollector('error')
  collector.recordProducer(producer)
  collector.recordMessage({ type: 'disposed', cleanup })
  collector.recordError(error)
  expect(collector.result()).toBeUndefined()
  collector.recordMessage({ type: 'result', observation })
  expect(collector.result()?.observation).toBe(observation)
})

it.each(['error', 'complete'] as const)('requires the expected %s terminal signal', (signal) => {
  const collector = new WorkerRunCollector(signal)
  collector.recordProducer(producer)
  collector.recordMessage({ type: 'result', observation })
  collector.recordMessage({ type: 'disposed', cleanup })
  if (signal === 'error') collector.recordMessage({ type: 'complete' })
  if (signal === 'complete') collector.recordError(error)
  expect(collector.result()).toBeUndefined()
})

it.each([
  ['complete', ['error', 'complete']],
  ['complete', ['complete', 'error']],
  ['error', ['error', 'complete']],
  ['error', ['complete', 'error']],
] as const)('latches conflicting signals for expected %s in order %j', (signal, events) => {
  const collector = new WorkerRunCollector(signal)
  collector.recordProducer(producer)
  collector.recordMessage({ type: 'result', observation })
  collector.recordMessage({ type: 'disposed', cleanup })
  for (const event of events) {
    if (event === 'error') collector.recordError('unexpected worker failure')
    if (event === 'complete') collector.recordMessage({ type: 'complete' })
  }
  expect(collector.result()).toBeUndefined()
  if (signal === 'error') collector.recordError(error)
  if (signal === 'complete') collector.recordMessage({ type: 'complete' })
  expect(collector.result()).toBeUndefined()
})

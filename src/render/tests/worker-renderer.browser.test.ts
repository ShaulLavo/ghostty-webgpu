import { testFontUrl } from '../../tests/fonts.js'
import { expect, it } from 'vitest'
import { createGhosttyError } from '../../core/error.js'
import type {
  ProducerObservation,
  WorkerBackend,
  WorkerRenderMessage,
  WorkerRenderRequest,
} from './fixtures/worker-protocol.js'

import { WorkerRunCollector, type WorkerRun } from './fixtures/worker-run.js'

type WorkerScenario = 'success' | 'expected-error' | 'unexpected-error'

async function runWorker(backend: WorkerBackend, scenario: WorkerScenario): Promise<WorkerRun> {
  const canvas = document.createElement('canvas')
  document.body.append(canvas)
  const worker = new Worker(new URL('./fixtures/native-render.worker.ts', import.meta.url), {
    type: 'module',
  })
  const producer = new Worker(new URL('./fixtures/output-producer.worker.ts', import.meta.url), {
    type: 'module',
  })
  const channel = new MessageChannel()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<WorkerRun>((resolve, reject) => {
      const expectedSignal = scenario === 'expected-error' ? 'error' : 'complete'
      const collector = new WorkerRunCollector(expectedSignal)
      const settle = () => {
        const result = collector.result()
        if (result) resolve(result)
      }
      timeout = setTimeout(
        () => reject(createGhosttyError('worker test', 'Dedicated worker test timed out')),
        15_000,
      )
      worker.onerror = (event) => {
        event.preventDefault()
        collector.recordError(event.message)
        if (expectedSignal === 'complete') {
          reject(createGhosttyError('worker test', event.message))
          return
        }
        settle()
      }
      producer.onerror = (event) => {
        event.preventDefault()
        reject(createGhosttyError('producer test', event.message))
      }
      producer.onmessage = ({ data }: MessageEvent<ProducerObservation>) => {
        collector.recordProducer(data)
        settle()
      }
      worker.onmessage = ({ data }: MessageEvent<WorkerRenderMessage>) => {
        if (
          data.type !== 'output-ready' &&
          data.type !== 'result' &&
          data.type !== 'disposed' &&
          data.type !== 'complete'
        ) {
          reject(createGhosttyError('worker test', 'Unexpected worker message'))
          return
        }
        collector.recordMessage(data)
        if (data.type === 'output-ready') producer.postMessage(channel.port1, [channel.port1])
        settle()
      }
      const offscreen = canvas.transferControlToOffscreen()
      const request: WorkerRenderRequest = {
        backend,
        canvas: offscreen,
        output: channel.port2,
        fontUrl: testFontUrl,
        wasmUrl: new URL('../../../ghostty-vt.wasm', import.meta.url).href,
        bridgeUrl: new URL('../../../bridge.wasm', import.meta.url).href,
        failAfterFrame: scenario !== 'success',
      }
      worker.postMessage(request, [offscreen, channel.port2])
    })
  } finally {
    clearTimeout(timeout)
    worker.terminate()
    producer.terminate()
    channel.port1.close()
    channel.port2.close()
    canvas.remove()
  }
}

function expectCleanup(result: WorkerRun): void {
  expect(result.cleanup.framesBeforeDispose).toBeGreaterThan(0)
  expect(result.cleanup.timersBeforeDispose).toBeGreaterThan(0)
  expect(result.cleanup).toMatchObject({
    frames: 0,
    timers: 0,
    fontRemoved: true,
    outputClosed: true,
    sessionDisposed: true,
    backendReleased: true,
  })
  expect(result.producer).toEqual({ type: 'sent', bufferDetached: true })
}

it.each(['webgpu', 'webgl'] as const)(
  '%s renders native output in a dedicated worker with a transferred producer port',
  async (backend) => {
    const result = await runWorker(backend, 'success')
    expect(result.error).toBeUndefined()
    expect(result.observation).toMatchObject({
      globalType: '[object DedicatedWorkerGlobalScope]',
      windowType: 'undefined',
      fontLoaded: true,
      glyphInk: true,
      cursor: { x: 18, y: 1, visible: true },
      key: [97],
      paste: Array.from(new TextEncoder().encode('\x1b[200~paste\x1b[201~')),
    })
    expect(
      result.observation.text
        .split('\n')
        .slice(0, 2)
        .map((line) => line.trimEnd()),
    ).toEqual(['worker native', 'direct-port-output'])
    expect(result.observation.metrics.zigFrames).toBeGreaterThanOrEqual(1)
    expect(result.observation.metrics.submittedFrames).toBeGreaterThanOrEqual(1)
    expect(result.observation.metrics.atlasUploadedBytes).toBeGreaterThan(0)
    expect(result.observation.animationFrames).toBeGreaterThan(0)
    expect(result.messageTypes).toEqual(['output-ready', 'result', 'disposed', 'complete'])
    expectCleanup(result)
  },
  20_000,
)

it.each(['webgpu', 'webgl'] as const)(
  '%s releases native resources before propagating a worker error',
  async (backend) => {
    const result = await runWorker(backend, 'expected-error')
    expect(result.error).toContain('Injected worker failure after native frame')
    expect(result.messageTypes).toEqual(['output-ready', 'result', 'disposed'])
    expect(result.cleanup.metrics?.zigFrames).toBeGreaterThanOrEqual(1)
    expect(result.cleanup.metrics?.submittedFrames).toBeGreaterThanOrEqual(1)
    expectCleanup(result)
  },
  20_000,
)

it.each(['webgpu', 'webgl'] as const)(
  '%s rejects a worker error when completion is expected',
  async (backend) => {
    await expect(runWorker(backend, 'unexpected-error')).rejects.toThrow(
      'Injected worker failure after native frame',
    )
  },
  20_000,
)

import { afterEach, expect, it } from 'vitest'
import { Terminal, TerminalWorkerPool } from '../../dist/worker/index.js'
import { requireWorkerWebGl } from '../render/tests/worker-webgl-capability.js'
import { requireWebGpu } from '../render/tests/webgpu-capability.js'
import type { TerminalOutputAck, TerminalOutputReady } from './protocol.js'

// The fixture has no animation frames and withholds the page's `drained` signals, so any output
// that reaches the page here was painted before its signal.
const withheld = new URL('./tests/withheld-drained.worker.ts', import.meta.url)
const font = new URL('../dom/tests/fixtures/font-resource/before.woff2', import.meta.url).href
const encoder = new TextEncoder()
const live: Terminal[] = []
const roots: HTMLElement[] = []

afterEach(async () => {
  for (const terminal of live.splice(0)) await terminal.dispose()
  for (const root of roots.splice(0)) root.remove()
})

async function open(backend: 'webgl' | 'webgpu', autoFit: boolean) {
  if (backend === 'webgl') await requireWorkerWebGl()
  else requireWebGpu()
  const family = 'HoldFont'
  const terminal = await Terminal.create({
    appearance: { font: { family, size: 16 }, grid: { columns: 20, rows: 3 } },
    autoFit,
    backend,
    fonts: [{ family, source: { url: font } }],
    pool: new TerminalWorkerPool({ workers: 1 }),
    workerUrl: withheld,
  })
  live.push(terminal)
  const root = document.createElement('div')
  root.style.cssText = 'width:420px;height:100px;position:relative'
  document.body.append(root)
  roots.push(root)
  await terminal.open(root)
  return terminal
}

const shown = (terminal: Terminal) => terminal.visibleLines().join('\n')
const releaseSignals = () => new BroadcastChannel('withheld-drained').postMessage('release')
// Absence needs a window for a wrong paint to arrive; this is a hang guard, not a speed check.
const quiet = () => new Promise((resolve) => setTimeout(resolve, 300))

it.each(['webgl', 'webgpu'] as const)(
  'keeps a %s resize from painting a write before its signal',
  async (backend) => {
    const terminal = await open(backend, true)
    await terminal.write('AA')
    // A larger font fits fewer cells, so the renderer resizes its canvas and repaints at once.
    await terminal.setFont({ size: 28 })
    await quiet()
    expect(shown(terminal)).not.toContain('AA')
    releaseSignals()
    await expect.poll(() => shown(terminal)).toContain('AA')
  },
  30_000,
)

it.each(['webgl', 'webgpu'] as const)(
  'paints %s producer output early only once a page signal covers it',
  async (backend) => {
    const terminal = await open(backend, false)
    const producer = new MessageChannel()
    const ready = new Promise<TerminalOutputReady>((resolve) => {
      producer.port1.onmessage = ({ data }: MessageEvent<TerminalOutputReady>) => resolve(data)
    })
    await terminal.attachOutputPort(producer.port2)
    const identity = await ready
    try {
      await terminal.write('XX')
      const parsed = new Promise<void>((resolve) => {
        producer.port1.onmessage = ({ data }: MessageEvent<TerminalOutputAck>) => {
          if (data.type === 'output-ack' && data.sequence === 1) resolve()
        }
      })
      // Producer output parsed after the answered write is not covered by that write's signal;
      // the producer's next chunk may still be in flight.
      const data = encoder.encode('PP')
      producer.port1.postMessage({ ...identity, type: 'output', sequence: 1, data })
      await parsed
      releaseSignals()
      await quiet()
      expect(shown(terminal)).not.toContain('PP')
      // A later write's reply covers the producer output, so its signal may paint it.
      await terminal.write('YY')
      await expect.poll(() => shown(terminal)).toContain('XXPPYY')
    } finally {
      producer.port1.close()
    }
  },
  30_000,
)

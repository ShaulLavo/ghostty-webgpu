import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { requireWebGpu } from '../render/tests/webgpu-capability.js'
import { requireWorkerWebGl } from '../render/tests/worker-webgl-capability.js'
import { testFontUrl } from '../tests/fonts.js'
import { Terminal, TerminalWorkerPool } from '../../dist/worker/index.js'
import type { TerminalOutputReady } from './protocol.js'

const family = 'PooledWorkerTest'
const active: Terminal[] = []
const containers: HTMLElement[] = []

afterEach(async () => {
  for (const terminal of active.splice(0)) await terminal.dispose()
  for (const container of containers.splice(0)) container.remove()
  vi.restoreAllMocks()
})

async function eventually(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!(await condition())) {
    if (Date.now() > deadline) expect.fail('condition did not hold')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function open(backend: 'webgl' | 'webgpu', pool: TerminalWorkerPool): Promise<Terminal> {
  const terminal = await Terminal.create({
    appearance: { cursor: { blink: false }, font: { family, size: 16 } },
    backend,
    pool,
    fonts: [{ family, source: { url: testFontUrl } }],
  })
  active.push(terminal)
  const root = document.createElement('div')
  root.style.cssText = 'width:480px;height:120px;position:relative'
  document.body.append(root)
  containers.push(root)
  await terminal.open(root)
  return terminal
}

function countWorkers() {
  const created: Worker[] = []
  const terminated = new Set<Worker>()
  const Original = globalThis.Worker
  vi.spyOn(globalThis, 'Worker').mockImplementation(function (
    url: string | URL,
    options?: WorkerOptions,
  ) {
    const worker = new Original(url, options)
    created.push(worker)
    const terminate = worker.terminate.bind(worker)
    worker.terminate = () => {
      terminated.add(worker)
      terminate()
    }
    return worker
  } as unknown as typeof Worker)
  return { created, terminated }
}

const shown = (terminal: Terminal, text: string) => () =>
  terminal.visibleLines().some((line) => line.includes(text))

describe.each(['webgl', 'webgpu'] as const)('%s pooled workers', (backend) => {
  async function require() {
    if (backend === 'webgpu') requireWebGpu()
    else await requireWorkerWebGl()
  }

  it('runs more terminals than workers, each with its own screen', async () => {
    await require()
    const workers = countWorkers()
    const pool = new TerminalWorkerPool({ workers: 2 })
    const terminals = [
      await open(backend, pool),
      await open(backend, pool),
      await open(backend, pool),
    ]
    expect(workers.created).toHaveLength(2)
    await Promise.all(terminals.map((terminal, index) => terminal.write(`pooled ${index}`)))
    for (const [index, terminal] of terminals.entries()) {
      await eventually(shown(terminal, `pooled ${index}`))
      expect(terminal.visibleLines().join('\n')).not.toContain(`pooled ${(index + 1) % 3}`)
      expect(terminal.diagnostics.rendererBackend).toBe(backend === 'webgl' ? 'webgl2' : 'webgpu')
    }
  })

  it('keeps siblings running when one terminal on a shared worker is disposed or fails', async () => {
    await require()
    const workers = countWorkers()
    const pool = new TerminalWorkerPool({ workers: 1 })
    const [first, second, third] = [
      await open(backend, pool),
      await open(backend, pool),
      await open(backend, pool),
    ]
    expect(workers.created).toHaveLength(1)
    await first!.dispose()
    expect(workers.terminated.size).toBe(0)

    // A producer sequence error fails only the terminal that received it.
    const channel = new MessageChannel()
    const ready = new Promise<TerminalOutputReady>((resolve) => {
      channel.port1.onmessage = ({ data }: MessageEvent<TerminalOutputReady>) => {
        if (data.type === 'ready') resolve(data)
      }
      channel.port1.start()
    })
    await second!.attachOutputPort(channel.port2)
    channel.port1.postMessage({
      ...(await ready),
      type: 'output',
      sequence: 2,
      data: new Uint8Array([1]),
    })
    await eventually(() => second!.lifecycle === 'disposed')
    channel.port1.close()
    expect(workers.terminated.size).toBe(0)

    await third!.write('still running')
    await eventually(shown(third!, 'still running'))
    await third!.dispose()
    expect(workers.terminated.size).toBe(1)
  })

  it('starts a fresh worker after the pool emptied', async () => {
    await require()
    const workers = countWorkers()
    const pool = new TerminalWorkerPool({ workers: 1 })
    await (await open(backend, pool)).dispose()
    expect(workers.terminated.size).toBe(1)
    const terminal = await open(backend, pool)
    expect(workers.created).toHaveLength(2)
    await terminal.write('fresh worker')
    await eventually(shown(terminal, 'fresh worker'))
  })
})

async function fillShare(element: Element, rgb: readonly number[]): Promise<number> {
  const image = new Image()
  image.src = `data:image/png;base64,${await page.screenshot({ element, save: false, scale: 'css' })}`
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')!
  context.drawImage(image, 0, 0)
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data
  let matching = 0
  for (let offset = 0; offset < data.length; offset += 4) {
    if (rgb.every((value, channel) => Math.abs(data[offset + channel]! - value) <= 4)) matching++
  }
  return matching / (data.length / 4)
}

describe.each(['webgl', 'webgpu'] as const)('%s pooled worker pixels', (backend) => {
  it('composites every terminal sharing a worker after each write', async () => {
    if (backend === 'webgpu') requireWebGpu()
    else await requireWorkerWebGl()
    const pool = new TerminalWorkerPool({ workers: 1 })
    const terminals = [await open(backend, pool), await open(backend, pool)]
    for (const color of [
      [25, 100, 200],
      [200, 60, 30],
    ]) {
      const fill = `\x1b[?25l\x1b[48;2;${color.join(';')}m\x1b[2J`
      await Promise.all(terminals.map((terminal) => terminal.write(fill)))
      for (const terminal of terminals) {
        const canvas = terminal.canvas!
        await expect.poll(() => fillShare(canvas, color), { timeout: 5_000 }).toBeGreaterThan(0.8)
      }
    }
  })
})

it('rejects a pool without workers', () => {
  expect(() => new TerminalWorkerPool({ workers: 0 })).toThrow(RangeError)
})

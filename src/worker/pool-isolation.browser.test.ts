import { afterEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { Terminal, TerminalWorkerPool } from '../../dist/worker/index.js'
import { requireWorkerWebGl } from '../render/tests/worker-webgl-capability.js'
import { requireWebGpu } from '../render/tests/webgpu-capability.js'
import type { TerminalOutputAck, TerminalOutputReady } from './protocol.js'

// Review cases for PR 158; each failed on the first pooled version.
const before = new URL('../dom/tests/fixtures/font-resource/before.woff2', import.meta.url).href
const after = new URL('../dom/tests/fixtures/font-resource/replacement.woff2', import.meta.url).href
const noFrames = new URL('./tests/no-animation-frames.worker.ts', import.meta.url)
const live: Terminal[] = []
const roots: HTMLElement[] = []
const encoder = new TextEncoder()

afterEach(async () => {
  for (const terminal of live.splice(0)) await terminal.dispose()
  for (const root of roots.splice(0)) root.remove()
})

async function open(
  backend: 'webgl' | 'webgpu' | 'auto',
  url: string,
  pool?: TerminalWorkerPool,
  workerUrl?: URL,
) {
  const family = 'ReviewFont'
  const terminal = await Terminal.create({
    appearance: { font: { family, size: 24 }, grid: { columns: 15, rows: 3 } },
    autoFit: false,
    backend,
    fonts: [{ family, source: { url } }],
    pool,
    workerUrl,
  })
  live.push(terminal)
  const root = document.createElement('div')
  root.style.cssText = 'width:420px;height:100px;position:relative'
  document.body.append(root)
  roots.push(root)
  await terminal.open(root)
  return terminal
}

async function brightPixels(terminal: Terminal) {
  const image = new Image()
  image.src = `data:image/png;base64,${await page.screenshot({ element: terminal.canvas!, save: false, scale: 'css' })}`
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')!
  context.drawImage(image, 0, 0)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
  let count = 0
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset]! > 128) count++
  }
  return count
}

async function writeGlyph(terminal: Terminal) {
  await terminal.write('\x1b[?25l\x1b[38;2;255;255;255mAAAA')
  await expect.poll(() => terminal.visibleLines()[0]).toContain('AAAA')
  await expect.poll(() => brightPixels(terminal)).toBeGreaterThan(0)
  return brightPixels(terminal)
}

function producerFor(terminal: Terminal) {
  const producer = new MessageChannel()
  const ready = new Promise<TerminalOutputReady>((resolve) => {
    producer.port1.onmessage = ({ data }: MessageEvent<TerminalOutputReady>) => resolve(data)
  })
  return { producer, ready: terminal.attachOutputPort(producer.port2).then(() => ready) }
}

it.each(['webgl', 'webgpu'] as const)(
  'isolates conflicting %s font faces with the same name',
  async (backend) => {
    if (backend === 'webgl') await requireWorkerWebGl()
    else requireWebGpu()
    const aloneBefore = await open(backend, before)
    const beforePixels = await writeGlyph(aloneBefore)
    await aloneBefore.dispose()
    const aloneAfter = await open(backend, after)
    const afterPixels = await writeGlyph(aloneAfter)
    await aloneAfter.dispose()
    expect(afterPixels).toBeGreaterThan(beforePixels)

    const pool = new TerminalWorkerPool({ workers: 1 })
    const pooledBefore = await open(backend, before, pool)
    const pooledAfter = await open(backend, after, pool)
    expect([await writeGlyph(pooledBefore), await writeGlyph(pooledAfter)]).toEqual([
      beforePixels,
      afterPixels,
    ])
  },
  30_000,
)

it('keeps synchronized output local to a terminal', async () => {
  await requireWorkerWebGl()
  const pool = new TerminalWorkerPool({ workers: 1 })
  const held = await open('webgl', before, pool)
  const sibling = await open('webgl', before, pool)
  const seen: string[] = []
  held.onText(({ rows }) => seen.push(rows.map((row) => row.text).join('\n')))
  await held.write('AAAA')
  await expect.poll(() => held.visibleLines()[0]).toContain('AAAA')
  await held.write('\x1b[?2026h\rMMMM')
  await sibling.write('gggg')
  await expect.poll(() => sibling.visibleLines()[0]).toContain('gggg')
  expect(held.visibleLines()[0]).toContain('AAAA')
  await held.write('\rgggg\x1b[?2026l')
  await expect.poll(() => held.visibleLines()[0]).toContain('gggg')
  expect(seen.some((text) => text.includes('MMMM'))).toBe(false)
})

it('keeps hardware-only initial selection after a pooled GPU device is deliberately disposed', async () => {
  requireWebGpu()
  await requireWorkerWebGl()
  const pool = new TerminalWorkerPool({ workers: 1 })
  const url = new URL('./tests/hardware-to-software.worker.ts', import.meta.url)
  url.searchParams.set('channel', 'rv-158-disposed-hardware')
  const keeper = await open('webgl', before, pool, url)
  const first = await open('auto', before, pool, url)
  expect(first.diagnostics.rendererBackend).toBe('webgpu')
  await first.dispose()
  const next = await open('auto', before, pool, url)
  expect(next.diagnostics.rendererBackend).toBe('webgl2')
  await keeper.dispose()
})

it('recovers two pooled terminals with just one replacement device', async () => {
  requireWebGpu()
  const pool = new TerminalWorkerPool({ workers: 1 })
  const channel = new BroadcastChannel('rv-158-shared-loss')
  const observed: number[] = []
  channel.onmessage = ({ data }: MessageEvent<{ type: string; request: number }>) => {
    if (data.type === 'device') observed.push(data.request)
  }
  try {
    const url = new URL('./tests/hardware-to-software.worker.ts', import.meta.url)
    url.searchParams.set('channel', channel.name)
    const first = await open('auto', before, pool, url)
    const second = await open('auto', before, pool, url)
    await first.write('AAAA')
    await second.write('MMMM')
    await expect.poll(() => first.visibleLines()[0]).toContain('AAAA')
    await expect.poll(() => second.visibleLines()[0]).toContain('MMMM')
    channel.postMessage('destroy')
    await expect.poll(() => observed).toEqual([1, 2])
    await first.write('\rgggg')
    await second.write('\rAAAA')
    await expect.poll(() => first.visibleLines()[0]).toContain('gggg')
    await expect.poll(() => second.visibleLines()[0]).toContain('AAAA')
    expect(observed).toEqual([1, 2])
  } finally {
    channel.close()
  }
})

it('cleans up the remote terminal after a page-side worker protocol failure', async () => {
  await requireWorkerWebGl()
  const pool = new TerminalWorkerPool({ workers: 1 })
  const failing = await open('webgl', before, pool)
  const sibling = await open('webgl', before, pool)
  const { producer, ready } = producerFor(failing)
  const unavailable = new MessageChannel()
  try {
    const identity = await ready
    const detached = structuredClone(unavailable.port2, { transfer: [unavailable.port2] })
    detached.close()
    await expect(failing.attachOutputPort(unavailable.port2)).rejects.toMatchObject({
      code: 'protocol',
    })
    expect(failing.lifecycle).toBe('disposed')
    const observed: TerminalOutputAck[] = []
    producer.port1.onmessage = ({ data }: MessageEvent<TerminalOutputAck>) => observed.push(data)
    producer.port1.postMessage({
      ...identity,
      type: 'output',
      sequence: 1,
      data: encoder.encode('orphan'),
    })
    await sibling.write('gggg')
    await expect.poll(() => sibling.visibleLines()[0]).toContain('gggg')
    expect(observed).toEqual([])
  } finally {
    producer.port1.close()
    unavailable.port1.close()
  }
})

// Frames come only from settled paints here, so a paint between two chunks would show.
it('never paints a pooled terminal between two output chunks the worker already holds', async () => {
  await requireWorkerWebGl()
  const pool = new TerminalWorkerPool({ workers: 1 })
  const terminal = await open('webgl', before, pool, noFrames)
  const seen: string[] = []
  terminal.onText(({ rows }) => seen.push(rows[0]?.text ?? ''))
  const { producer, ready } = producerFor(terminal)
  try {
    const identity = await ready
    // The second chunk is sent only after the first is parsed, behind any paint it queued.
    const parsed = new Promise<void>((resolve) => {
      producer.port1.onmessage = ({ data }: MessageEvent<TerminalOutputAck>) => {
        if (data.type !== 'output-ack') return
        if (data.sequence === 2) resolve()
        if (data.sequence !== 1) return
        const chunk = { ...identity, type: 'output', sequence: 2, data: encoder.encode('BB') }
        producer.port1.postMessage(chunk)
      }
    })
    producer.port1.postMessage({
      ...identity,
      type: 'output',
      sequence: 1,
      data: encoder.encode('AA'),
    })
    await parsed
    await terminal.write('CC')
    await expect.poll(() => terminal.visibleLines()[0]).toContain('AABBCC')
    expect(seen.filter((text) => text.includes('AA') && !text.includes('AABB'))).toEqual([])
  } finally {
    producer.port1.close()
  }
})

import { testFontUrl } from '../tests/fonts.js'
import { afterEach, expect, it } from 'vitest'
import { Terminal as WorkerTerminal, TerminalWorkerError } from '../../dist/worker/index.js'
import type { TerminalApi } from '../../dist/dom/terminal-api.js'
import { displayedPixels } from '../render/webgl/tests/fixture.js'

const family = 'WorkerLigatureTest'
const active: TerminalApi[] = []
const containers: HTMLElement[] = []

afterEach(async () => {
  for (const terminal of active.splice(0)) await terminal.dispose()
  for (const container of containers.splice(0)) container.remove()
})

async function rowPixels(
  ligatures: boolean,
): Promise<{ pixels: Uint8Array; width: number; cell: number }> {
  const container = document.createElement('div')
  container.style.cssText = 'width:480px;height:120px;position:relative'
  document.body.append(container)
  containers.push(container)
  const terminal = await WorkerTerminal.create({
    accessibility: false,
    appearance: { font: { family, size: 16 }, cursor: { blink: false } },
    backend: 'webgl',
    fonts: [{ family, source: { url: testFontUrl } }],
    ligatures,
  })
  active.push(terminal)
  await terminal.open(container)
  await terminal.write('\x1b[?25la=>b')
  const canvas = container.querySelector('canvas')!
  const geometry = await terminal.geometry()
  const deadline = Date.now() + 5_000
  for (;;) {
    const pixels = await displayedPixels(canvas)
    const lines = terminal.visibleLines?.() ?? []
    if (pixels.some((value, index) => index % 4 !== 3 && value > 128) && lines.length !== 0)
      return { pixels, width: canvas.width, cell: canvas.width / geometry.columns }
    if (Date.now() > deadline) expect.fail('The worker frame did not arrive')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function cellsDiffer(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  cell: number,
  first: number,
  last: number,
): boolean {
  const height = a.length / 4 / width
  for (let y = 0; y < height; y += 1) {
    for (let x = Math.round(first * cell); x < Math.round(last * cell); x += 1) {
      const index = (y * width + x) * 4
      for (let channel = 0; channel < 3; channel += 1)
        if (Math.abs(a[index + channel]! - b[index + channel]!) > 2) return true
    }
  }
  return false
}

it('joins runs in the worker from the font face it loads', async (context) => {
  const off = await rowPixels(false).catch((cause: unknown) => {
    // Engines without worker rendering report a capability failure before any pixels.
    if (cause instanceof TerminalWorkerError && cause.code === 'capability') context.skip()
    throw cause
  })
  const on = await rowPixels(true)
  expect(on.width).toBe(off.width)
  expect(cellsDiffer(on.pixels, off.pixels, on.width, on.cell, 1, 3), 'the => run joins').toBe(true)
  expect(cellsDiffer(on.pixels, off.pixels, on.width, on.cell, 0, 1), 'a stays per-cell').toBe(
    false,
  )
  expect(cellsDiffer(on.pixels, off.pixels, on.width, on.cell, 3, 4), 'b stays per-cell').toBe(
    false,
  )
})

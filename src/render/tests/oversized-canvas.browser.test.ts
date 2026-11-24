import { afterEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { Terminal } from '../../../dist/index.js'
import { WebGpuTerminalRenderer } from '../../../dist/render/webgpu/renderer.js'
import type { TerminalApi } from '../../../dist/dom/terminal-api.js'
import { testFontUrl } from '../../tests/fonts.js'
import { requireWebGpu } from './webgpu-capability.js'

const family = 'OversizedCanvasTest'
const assets = {
  wasm: new URL('../../../ghostty-vt.wasm', import.meta.url).href,
  bridge: new URL('../../../bridge.wasm', import.meta.url).href,
}
const active: TerminalApi[] = []
const roots: HTMLElement[] = []
afterEach(async () => {
  for (const terminal of active.splice(0)) await terminal.dispose()
  for (const root of roots.splice(0)) root.remove()
})

async function open(columns: number): Promise<TerminalApi> {
  const terminal = await Terminal.create({
    appearance: {
      font: { family, size: 16 },
      cursor: { blink: false },
      grid: { columns, rows: 3 },
    },
    autoFit: false,
    runtime: { kind: 'owned', options: assets },
    rendererFactory: (options) => WebGpuTerminalRenderer.create(options),
  })
  active.push(terminal)
  const root = document.createElement('div')
  root.style.cssText = 'width:320px;height:60px;position:relative'
  document.body.append(root)
  roots.push(root)
  await terminal.open(root)
  return terminal
}

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

// Terminals on one device share a queue submit; one invalid canvas texture would void them all.
it('keeps painting a WebGPU sibling when another terminal outgrows the texture limit', async () => {
  requireWebGpu()
  document.fonts.add(await new FontFace(family, `url(${JSON.stringify(testFontUrl)})`).load())
  const limit = (await navigator.gpu.requestAdapter())!.limits.maxTextureDimension2D
  const sibling = await open(30)
  // Every cell is at least 8 device pixels wide, so this grid exceeds the limit.
  const oversized = await open(Math.ceil(limit / 8) + 1)
  const errors: unknown[] = []
  oversized.on('error', (event) => errors.push(event.cause))
  expect(oversized.canvas!.width).toBeGreaterThan(limit)
  const color = [200, 60, 30]
  const fill = `\x1b[?25l\x1b[48;2;${color.join(';')}m\x1b[2J`
  // Synchronous main-entry writes land both terminals in one animation frame and one submit.
  sibling.write(fill)
  oversized.write(fill)
  await expect
    .poll(() => fillShare(sibling.canvas!, color), { timeout: 5_000 })
    .toBeGreaterThan(0.5)
  await expect.poll(() => errors.length).toBeGreaterThan(0)
  expect(String(errors[0])).toContain('texture limit')
})

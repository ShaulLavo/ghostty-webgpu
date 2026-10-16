import { afterEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { TerminalSession } from '../../term/session.js'
import { createGhosttyWebGpuTerminalFromSession } from '../../dom/terminal.js'
import { GhosttyRuntime } from '../../core/runtime.js'
import { fitTerminalFont } from '../../dom/fit.js'
import type { TerminalFittedFont } from '../../term/types.js'
import { CanvasGlyphRasterizer } from '../atlas/canvas-rasterizer.js'
import { CanvasTerminalRenderer } from '../canvas/renderer.js'
import { DomTerminalRenderer } from '../dom/renderer.js'
import { WebGpuTerminalRenderer } from '../renderer.js'
import { WebGlTerminalRenderer } from '../webgl/renderer.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup()
  cleanups.length = 0
})

function squareFont(lineHeight = 0.6): TerminalFittedFont {
  const settings = {
    boldWeight: 700,
    family: 'monospace',
    letterSpacing: 0,
    lineHeight,
    size: 40,
    weight: 400,
  }
  const measured = fitTerminalFont(document, settings, 1)
  return fitTerminalFont(
    document,
    {
      ...settings,
      letterSpacing: measured.deviceCellHeight - measured.deviceCharWidth,
    },
    1,
  )
}

async function pixels(element: Element): Promise<ImageData> {
  const image = new Image()
  image.src = `data:image/png;base64,${await page.screenshot({ element, save: false, scale: 'css' })}`
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')!
  context.drawImage(image, 0, 0)
  return context.getImageData(0, 0, canvas.width, canvas.height)
}

it.each([1, 1.25, 2])(
  'clips oversized atlas ink to its complete cell span at DPR %s',
  (pixelRatio) => {
    const measured = squareFont()
    const font = fitTerminalFont(document, { ...measured.settings, letterSpacing: -4 }, pixelRatio)
    const rasterizer = new CanvasGlyphRasterizer({ font })
    for (const cellSpan of [1, 2]) {
      for (const text of ['●', 'Égj', '界', '😀']) {
        const bitmap = rasterizer.rasterize({
          cellSpan,
          text,
          italic: true,
          weight: 'bold',
          foreground: { r: 255, g: 255, b: 255 },
        })
        expect(bitmap, text).toBeDefined()
        expect(bitmap!.offsetX).toBeGreaterThanOrEqual(0)
        expect(bitmap!.offsetY).toBeGreaterThanOrEqual(0)
        expect(bitmap!.offsetX + bitmap!.width).toBeLessThanOrEqual(font.deviceCellWidth * cellSpan)
        expect(bitmap!.offsetY + bitmap!.height).toBeLessThanOrEqual(font.deviceCellHeight)
      }
    }
  },
)

const backends = [
  { name: 'WebGPU', create: WebGpuTerminalRenderer.create },
  { name: 'WebGL2', create: WebGlTerminalRenderer.create },
  { name: 'Canvas2D', create: CanvasTerminalRenderer.create },
  { name: 'DOM', create: DomTerminalRenderer.create },
]

describe.each(backends)('$name short-line cells', ({ name, create }) => {
  it('keeps coloured dots inside their square cells after a partial row update', async () => {
    const runtime = await GhosttyRuntime.create()
    cleanups.push(() => runtime.dispose())
    const terminal = runtime.createTerminal({ columns: 6, rows: 3 })
    const state = runtime.createRenderState(terminal)
    const host = document.createElement('div')
    host.style.cssText = 'position:relative;width:max-content;background:black;'
    const canvas = document.createElement('canvas')
    canvas.style.display = 'block'
    host.append(canvas)
    document.body.append(host)
    cleanups.push(() => host.remove())
    const font = squareFont()
    expect(font.deviceCellWidth).toBe(font.deviceCellHeight)
    expect(font.charTop).toBeLessThan(0)
    const renderer = await create({
      canvas,
      columns: 6,
      rows: 3,
      font,
      renderState: state,
      theme: { background: { r: 0, g: 0, b: 0 }, minimumContrast: 1 },
    })
    cleanups.push(() => renderer.dispose())
    terminal.write('\x1b[?25l')
    renderer.notifyWrite()
    await expect.poll(() => renderer.hasPendingFrame).toBe(false)
    terminal.write('\x1b[2;1H\x1b[38;2;255;0;0m● \x1b[38;2;0;255;0m● \x1b[38;2;0;0;255m●')
    renderer.notifyWrite()
    await expect.poll(() => renderer.hasPendingFrame).toBe(false)
    const element = name === 'DOM' ? host.querySelector('.ghostty-webgpu-frame')! : canvas
    const image = await pixels(element)
    const coverage = [0, 0, 0]
    let outside = 0
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const offset = (y * image.width + x) * 4
        if (!image.data[offset] && !image.data[offset + 1] && !image.data[offset + 2]) continue
        const column = Math.floor(x / font.deviceCellWidth)
        if (y < font.deviceCellHeight || y >= font.deviceCellHeight * 2 || column % 2 === 1) {
          outside += 1
          continue
        }
        coverage[column / 2]! += 1
      }
    }
    expect(coverage.every((count) => count > 40)).toBe(true)
    expect(outside).toBe(0)
  })
})

it('shows square-cell coloured dots beside normal line spacing through the public session API', async () => {
  const runtime = await GhosttyRuntime.create()
  cleanups.push(() => runtime.dispose())
  const comparison = document.createElement('section')
  comparison.style.cssText =
    'display:flex;gap:24px;width:max-content;padding:24px;background:#181c24;color:white;font:16px monospace;'
  document.body.append(comparison)
  cleanups.push(() => comparison.remove())
  const short = squareFont()
  for (const lineHeight of [0.6, 1]) {
    const panel = document.createElement('div')
    const label = document.createElement('p')
    label.textContent = `lineHeight ${lineHeight} · font ${short.settings.size}px`
    panel.append(label)
    const host = document.createElement('div')
    host.style.width = `${short.cssCellWidth * 9}px`
    host.style.height = '340px'
    panel.append(host)
    comparison.append(panel)
    const session = await TerminalSession.create<Event>({
      appearance: {
        font: { ...short.settings, lineHeight },
        cursor: { blink: false },
        grid: { columns: 9, rows: 6 },
      },
      runtime: { kind: 'borrowed', runtime },
    })
    session.setTheme({ ...session.appearance.theme, background: { r: 0, g: 0, b: 0 } })
    const terminal = createGhosttyWebGpuTerminalFromSession(session, {
      autoFit: false,
      fitEnvironment: { getPixelRatio: () => 1 },
      rendererFactory: (options) => CanvasTerminalRenderer.create(options),
    })
    cleanups.push(() => terminal.dispose())
    await terminal.open(host)
    const rows = Array.from({ length: 5 }, (_, row) =>
      Array.from({ length: 9 }, (_, column) => {
        const colors = ['255;106;92', '80;220;190', '116;166;255']
        const dots = ['·', '•', '●']
        return `\x1b[38;2;${colors[(row + column) % 3]}m${dots[column % 3]}`
      }).join(''),
    )
    terminal.write('\x1b[?25l' + rows.join('\r\n'))
    await expect.poll(() => terminal.hasPendingFrame).toBe(false)
    expect(terminal.appearance.font.lineHeight).toBe(lineHeight)
    if (lineHeight === 0.6)
      expect(terminal.appearance.grid.cellWidth).toBe(terminal.appearance.grid.cellHeight)
  }
  await page.screenshot({
    element: comparison,
    path: '../../../.artifacts/short-line-comparison.png',
    scale: 'css',
  })
})

import { afterAll, beforeAll, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { GhosttyRuntime } from '../../core/runtime.js'
import { GhosttySelectionGesture } from '../../core/selection.js'
import type { RenderRow } from '../../core/types.js'
import type { TerminalFittedFont } from '../../term/types.js'
import { CanvasGlyphRasterizer } from '../atlas/canvas-rasterizer.js'
import { CanvasTerminalRenderer } from '../canvas/renderer.js'
import { WebGpuTerminalRenderer } from '../renderer.js'
import { WebGlTerminalRenderer } from '../webgl/renderer.js'
import { fittedFont, rgb, TestClock } from '../webgl/tests/fixture.js'

const font = fittedFont(24, 48, 32)
const columns = 26
const rows = 3
const emojiText = '👩‍💻 👨‍👩‍👧‍👦 🧪 💻'
const background = rgb(16, 16, 16)
const foreground = rgb(0, 255, 255)
const viewport = { width: window.innerWidth, height: window.innerHeight }

const intrinsicFont = new FontFace(
  'Intrinsic Colors',
  `url(${new URL('./fixtures/intrinsic-colors.ttf', import.meta.url).href})`,
)

beforeAll(async () => {
  await page.viewport(800, 600)
  document.fonts.add(await intrinsicFont.load())
})
afterAll(() => {
  document.fonts.delete(intrinsicFont)
  return page.viewport(viewport.width, viewport.height)
})

it.each([
  ['W', 255],
  ['B', 0],
  ['G', 128],
] as const)('preserves intrinsic achromatic RGB for %s', (text, channel) => {
  const rasterizer = new CanvasGlyphRasterizer({
    font: { ...font, settings: { ...font.settings, family: '"Intrinsic Colors"' } },
  })
  const bitmap = rasterizer.rasterize({
    cellSpan: 2,
    foreground,
    italic: false,
    text,
    weight: 'normal',
  })!
  expect(bitmap.kind).toBe('color')
  const center = Math.floor((bitmap.width * bitmap.height) / 2) * 4
  expect(Array.from(bitmap.pixels.subarray(center, center + 4))).toEqual([
    channel,
    channel,
    channel,
    255,
  ])
  const ordinary = rasterizer.rasterize({
    cellSpan: 2,
    foreground,
    italic: false,
    text: 'M',
    weight: 'normal',
  })!
  expect(ordinary.kind).toBe('grayscale')
  expect(ordinary.pixels).toHaveLength(ordinary.width * ordinary.height)
})

it.each(['⚫', '⚪', '💻', '👩‍💻', '👨‍👩‍👧‍👦', '🧪'])(
  'rasterizes visible fallback glyphs for %s',
  (text) => {
    const rasterizer = new CanvasGlyphRasterizer({ font })
    const bitmap = rasterizer.rasterize({
      cellSpan: 2,
      foreground,
      italic: false,
      text,
      weight: 'normal',
    })!
    expect(bitmap).toBeDefined()
    const bytesPerPixel = bitmap.kind === 'color' ? 4 : 1
    expect(bitmap.pixels).toHaveLength(bitmap.width * bitmap.height * bytesPerPixel)
    expect(
      bitmap.pixels.some(
        (value, offset) => offset % bytesPerPixel === bytesPerPixel - 1 && value > 0,
      ),
    ).toBe(true)
  },
)

function referenceCanvas(
  renderRows: readonly RenderRow[],
  targetFont: TerminalFittedFont = font,
  ink = '#00ffff',
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = columns * targetFont.deviceCellWidth
  canvas.height = rows * targetFont.deviceCellHeight
  const context = canvas.getContext('2d')!
  context.fillStyle = '#101010'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.font = `400 ${targetFont.settings.size}px ${targetFont.settings.family}`
  context.textAlign = 'center'
  context.textBaseline = 'alphabetic'
  context.fillStyle = ink
  for (const row of renderRows) {
    for (const cell of row.cells) {
      if (cell.continuation || !cell.text) continue
      const span = row.cells[cell.x + 1]?.continuation ? 2 : 1
      context.fillText(
        cell.text,
        (cell.x + span / 2) * targetFont.deviceCellWidth,
        row.y * targetFont.deviceCellHeight + targetFont.deviceBaseline,
      )
    }
  }
  return canvas
}

async function displayedPixels(canvas: HTMLCanvasElement): Promise<Uint8ClampedArray> {
  const screenshot = await page.screenshot({ element: canvas, save: false, scale: 'css' })
  const image = new Image()
  image.src = `data:image/png;base64,${screenshot}`
  await image.decode()
  const decoded = document.createElement('canvas')
  decoded.width = image.naturalWidth
  decoded.height = image.naturalHeight
  const context = decoded.getContext('2d')!
  context.drawImage(image, 0, 0)
  return context.getImageData(0, 0, decoded.width, decoded.height).data
}

function mismatchedPixels(actual: Uint8ClampedArray, expected: Uint8ClampedArray): number {
  expect(actual.length).toBe(expected.length)
  let mismatches = 0
  for (let offset = 0; offset < actual.length; offset += 4) {
    const difference = Math.max(
      Math.abs(actual[offset]! - expected[offset]!),
      Math.abs(actual[offset + 1]! - expected[offset + 1]!),
      Math.abs(actual[offset + 2]! - expected[offset + 2]!),
    )
    if (difference > 8) mismatches += 1
  }
  return mismatches
}

it.each([
  ['webgpu', WebGpuTerminalRenderer],
  ['webgl2', WebGlTerminalRenderer],
] as const)('presents legacy and clustered ZWJ emoji through %s', async (backend, Renderer) => {
  const runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns, rows })
  const state = runtime.createRenderState(terminal)
  const canvas = document.createElement('canvas')
  canvas.style.backgroundColor = '#101010'
  const fixture = document.createElement('div')
  document.body.append(fixture)
  let renderer: Awaited<ReturnType<typeof Renderer.create>> | undefined
  try {
    terminal.write(`\x1b[?25l${emojiText}\r\n\x1b[?2027h${emojiText}\r\n⚫ ⚪ 🧪 💻`)
    state.update()
    const renderRows = state.readRows()
    expect(renderRows[0]!.cells[0]!.text).toBe('👩‍')
    expect(renderRows[0]!.cells[2]!.text).toBe('💻')
    expect(renderRows[1]!.cells[0]!.text).toBe('👩‍💻')
    expect(renderRows[1]!.cells[3]!.text).toBe('👨‍👩‍👧‍👦')
    expect(renderRows[1]!.cells[1]!.continuation).toBe(true)
    expect(renderRows[1]!.cells[4]!.continuation).toBe(true)
    const reference = referenceCanvas(renderRows)
    const label = document.createElement('p')
    label.textContent = `${backend} / direct Canvas2D. Rows: legacy, mode 2027, achromatic controls.`
    fixture.append(label, canvas, reference)
    const clock = new TestClock()
    renderer = await Renderer.create({
      canvas,
      columns,
      font,
      renderState: state,
      rows,
      schedulerClock: clock,
      theme: { background, foreground, minimumContrast: 1 },
    })
    clock.flushFrame()
    await page.screenshot({
      element: fixture,
      path: `../../../.artifacts/emoji-${backend}.png`,
      scale: 'css',
    })
    const actual = await displayedPixels(canvas)
    const expected = await displayedPixels(reference)
    expect(mismatchedPixels(actual, expected)).toBeLessThan(40)
  } finally {
    renderer?.dispose()
    runtime.dispose()
    fixture.remove()
  }
})

const mixedFont = { ...font, settings: { ...font.settings, family: '"Intrinsic Colors"' } }

it('caches mixed COLR glyphs by foreground while retaining their fixed gray layer', () => {
  const rasterizer = new CanvasGlyphRasterizer({ font: mixedFont })
  const bitmaps = [rgb(0, 255, 255), rgb(255, 0, 255)].map((color) => {
    const input = {
      cellSpan: 2,
      foreground: color,
      italic: false,
      text: 'X',
      weight: 'normal',
    } as const
    const bitmap = rasterizer.rasterize(input)!
    expect(bitmap.kind).toBe('color')
    const middle = Math.floor(bitmap.height / 2) * bitmap.width
    expect(Array.from(bitmap.pixels.subarray((middle + 4) * 4, (middle + 4) * 4 + 4))).toEqual([
      color.r,
      color.g,
      color.b,
      255,
    ])
    expect(
      Array.from(
        bitmap.pixels.subarray(
          (middle + bitmap.width - 5) * 4,
          (middle + bitmap.width - 5) * 4 + 4,
        ),
      ),
    ).toEqual([128, 128, 128, 255])
    expect(rasterizer.rasterize(input)).toBe(bitmap)
    return bitmap
  })
  expect(bitmaps[0]).not.toBe(bitmaps[1])
})

it.each(['M', 'C'])('reuses a one-byte mask for %s across foreground colors', (text) => {
  const rasterizer = new CanvasGlyphRasterizer({ font: mixedFont })
  const input = { cellSpan: 2, foreground, italic: false, text, weight: 'normal' } as const
  const bitmap = rasterizer.rasterize(input)!
  expect(bitmap.kind).toBe('grayscale')
  expect(bitmap.pixels).toHaveLength(bitmap.width * bitmap.height)
  const alternate = { ...input, foreground: rgb(255, 0, 255) }
  expect(rasterizer.rasterize(alternate)).toBe(bitmap)
})

it('bounds mixed COLR color variants while retaining recently reused colors', () => {
  const rasterizer = new CanvasGlyphRasterizer({ font: mixedFont })
  const input = { cellSpan: 2, foreground, italic: false, text: 'X', weight: 'normal' } as const
  const first = rasterizer.rasterize(input)!
  const recentInput = { ...input, foreground: rgb(255, 0, 255) }
  const recent = rasterizer.rasterize(recentInput)!
  for (let index = 0; index < 4_096; index += 1) {
    const variant = { ...input, foreground: rgb(index >> 8, index & 255, 0) }
    rasterizer.rasterize(variant)
    expect(rasterizer.rasterize(recentInput)).toBe(recent)
  }
  const rerasterized = rasterizer.rasterize(input)!
  expect(rerasterized).not.toBe(first)
  expect(rerasterized).toEqual(first)
})

it.each([
  ['webgpu', WebGpuTerminalRenderer],
  ['webgl2', WebGlTerminalRenderer],
  ['canvas2d', CanvasTerminalRenderer],
] as const)('recolors cached mixed COLR layers through %s', async (backend, Renderer) => {
  const runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns, rows })
  const state = runtime.createRenderState(terminal)
  const selection = new GhosttySelectionGesture(terminal)
  const canvas = document.createElement('canvas')
  canvas.style.backgroundColor = '#101010'
  const fixture = document.createElement('div')
  const label = document.createElement('p')
  document.body.append(fixture)
  fixture.append(label, canvas)
  let renderer: Awaited<ReturnType<typeof Renderer.create>> | undefined
  let reference: HTMLCanvasElement | undefined
  try {
    terminal.write('\x1b[?25l  X')
    const clock = new TestClock()
    renderer = await Renderer.create({
      canvas,
      columns,
      font: mixedFont,
      renderState: state,
      rows,
      schedulerClock: clock,
      theme: {
        background,
        foreground,
        minimumContrast: 1,
        selectionBackground: background,
        selectionForeground: rgb(255, 255, 0),
      },
    })
    const write = (sgr: string) => {
      terminal.write(`\r\x1b[2K  \x1b[${sgr}mX`)
      renderer!.notifyWrite()
    }
    const phases = [
      { name: 'theme-cyan', ink: '#00ffff', change: () => renderer!.schedule() },
      {
        name: 'theme-magenta',
        ink: '#ff00ff',
        change: () => renderer!.setTheme({ foreground: rgb(255, 0, 255) }),
      },
      { name: 'sgr-green', ink: '#00ff00', change: () => write('38;2;0;255;0') },
      {
        name: 'selected-yellow',
        ink: '#ffff00',
        change: () => {
          expect(selection.selectRange({ x: 2, y: 0 }, { x: 2, y: 0 }).selectionInstalled).toBe(
            true,
          )
          renderer!.notifySelectionChange()
        },
      },
      {
        name: 'selected-magenta',
        ink: '#ff00ff',
        change: () => renderer!.setTheme({ selectionForeground: rgb(255, 0, 255) }),
      },
      {
        name: 'unselected-green',
        ink: '#00ff00',
        change: () => {
          expect(selection.clear()).toBe(true)
          renderer!.notifySelectionChange()
        },
      },
      { name: 'sgr-cyan', ink: '#00ffff', change: () => write('38;2;0;255;255') },
      { name: 'theme-return', ink: '#ff00ff', change: () => write('39') },
      {
        name: 'contrast-white',
        ink: '#ffffff',
        change: () => renderer!.setTheme({ foreground: rgb(32, 32, 32), minimumContrast: 4.5 }),
      },
    ]
    for (const phase of phases) {
      phase.change()
      clock.flushFrame()
      const renderRows = state.readRows()
      expect(renderRows[0]!.cells[2]!.text).toBe('X')
      expect(renderRows[0]!.cells[2]!.selected).toBe(phase.name.startsWith('selected-'))
      reference?.remove()
      reference = referenceCanvas(renderRows, mixedFont, phase.ink)
      fixture.append(reference)
      const actual = await displayedPixels(canvas)
      const expected = await displayedPixels(reference)
      const differences = mismatchedPixels(actual, expected)
      label.textContent = `${backend} ${phase.name}. Renderer above direct Canvas2D. ${differences} differing pixels.`
      await page.screenshot({
        element: fixture,
        path: `../../../.artifacts/mixed-${backend}-${phase.name}.png`,
        scale: 'css',
      })
      expect.soft(differences, phase.name).toBe(0)
    }
  } finally {
    renderer?.dispose()
    selection.dispose()
    runtime.dispose()
    fixture.remove()
  }
})

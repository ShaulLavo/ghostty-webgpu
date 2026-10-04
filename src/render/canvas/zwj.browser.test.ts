import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { GhosttyRuntime } from '../../core/runtime.js'
import { GhosttySelectionGesture } from '../../core/selection.js'
import type { TerminalFittedFont } from '../../term/types.js'
import { TestClock } from '../webgl/tests/fixture.js'
import { CanvasTerminalRenderer } from './renderer.js'

const emojiFont = new FontFace(
  'Canvas ZWJ Emoji',
  `url(${new URL('./tests/zwj-emoji.ttf', import.meta.url).href})`,
)
const textFont = new FontFace(
  'Canvas ZWJ Text',
  `url(${new URL('../../../site/public/fonts/jetbrains-mono-latin-400-normal.woff2', import.meta.url).href})`,
)
const cleanups: (() => void)[] = []
const viewport = { width: window.innerWidth, height: window.innerHeight }
const columns = 24
const rows = 3
const font: TerminalFittedFont = {
  charLeft: 0,
  charTop: 4,
  cssCellHeight: 48,
  cssCellWidth: 24,
  deviceBaseline: 36,
  deviceCellHeight: 48,
  deviceCellWidth: 24,
  deviceCharHeight: 32,
  deviceCharWidth: 24,
  pixelRatio: 1,
  settings: {
    boldWeight: 700,
    family: '"Canvas ZWJ Text", "Canvas ZWJ Emoji"',
    letterSpacing: 0,
    lineHeight: 1.5,
    size: 32,
    weight: 400,
  },
}
const specimens = [
  { name: 'technologist', text: '👩‍💻', legacySpan: 4 },
  { name: 'family', text: '👨‍👩‍👧‍👦', legacySpan: 8 },
] as const

beforeAll(async () => {
  await page.viewport(800, 600)
  document.fonts.add(await emojiFont.load())
  document.fonts.add(await textFont.load())
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.restoreAllMocks()
})

afterAll(async () => {
  document.fonts.delete(emojiFont)
  document.fonts.delete(textFont)
  await page.viewport(viewport.width, viewport.height)
})

function newCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = columns * font.deviceCellWidth
  canvas.height = rows * font.deviceCellHeight
  canvas.style.backgroundColor = '#101010'
  return canvas
}

function drawText(
  context: CanvasRenderingContext2D,
  text: string,
  column: number,
  row: number,
  span = 1,
): void {
  context.fillText(
    text,
    (column + span / 2) * font.deviceCellWidth,
    row * font.deviceCellHeight + font.deviceBaseline,
  )
}

function oracle(text: string, legacySpan: number): HTMLCanvasElement {
  const canvas = newCanvas()
  const context = canvas.getContext('2d')!
  context.font = `400 ${font.settings.size}px ${font.settings.family}`
  context.textAlign = 'center'
  context.textBaseline = 'alphabetic'
  context.fillStyle = '#ffffff'
  for (const [row, span] of [
    [0, legacySpan],
    [1, 2],
  ] as const) {
    drawText(context, 'A', 0, row)
    if (row === 1) drawText(context, text, 1, row, span)
    if (row === 0) {
      const owners = text.split('‍')
      owners.forEach((owner, index) =>
        drawText(context, owner + (index < owners.length - 1 ? '‍' : ''), 1 + index * 2, row, 2),
      )
    }
    drawText(context, 'B', 1 + span, row)
  }
  drawText(context, 'X', 0, 2)
  drawText(context, '界', 1, 2, 2)
  drawText(context, 'é', 3, 2)
  drawText(context, '😀', 4, 2, 2)
  context.fillStyle = '#ff0000'
  drawText(context, 'R', 6, 2)
  context.fillStyle = '#00ff00'
  drawText(context, 'G', 7, 2)
  context.fillStyle = '#ffffff'
  drawText(context, 'Z', 8, 2)
  return canvas
}

function pixels(canvas: HTMLCanvasElement, row: number): Uint8ClampedArray {
  return canvas
    .getContext('2d')!
    .getImageData(0, row * font.deviceCellHeight, canvas.width, font.deviceCellHeight).data
}

function differences(actual: Uint8ClampedArray, expected: Uint8ClampedArray): number {
  expect(actual.length).toBe(expected.length)
  let count = 0
  for (let offset = 0; offset < actual.length; offset += 1) {
    if (Math.abs(actual[offset]! - expected[offset]!) > 1) count += 1
  }
  return count
}

async function fixture(content: string) {
  const runtime = await GhosttyRuntime.create()
  cleanups.push(() => runtime.dispose())
  const terminal = runtime.createTerminal({ columns, rows })
  const state = runtime.createRenderState(terminal)
  terminal.write(content)
  state.update()
  const canvas = newCanvas()
  const container = document.createElement('div')
  document.body.append(container)
  cleanups.push(() => container.remove())
  const clock = new TestClock()
  const renderer = await CanvasTerminalRenderer.create({
    canvas,
    columns,
    font,
    renderState: state,
    rows,
    schedulerClock: clock,
    theme: {
      foreground: { r: 255, g: 255, b: 255 },
      minimumContrast: 1,
    },
  })
  cleanups.push(() => renderer.dispose())
  container.append(canvas)
  clock.flushFrame()
  return { canvas, clock, container, renderer, state, terminal }
}

it.each(specimens)(
  'preserves native $name owners in legacy and mode-2027 cells',
  async (specimen) => {
    const { name, text, legacySpan } = specimen
    const controls = 'X界é😀\x1b[38;2;255;0;0mR\x1b[38;2;0;255;0mG\x1b[0mZ'
    const native = await fixture(`\x1b[?25lA${text}B\r\n\x1b[?2027hA${text}B\r\n${controls}`)
    const reference = oracle(text, legacySpan)
    const nativeLabel = document.createElement('p')
    nativeLabel.textContent = `${name}: native Canvas. Legacy occupancy, mode 2027, mixed controls.`
    const referenceLabel = document.createElement('p')
    referenceLabel.textContent = 'Native-owner Canvas shaping control with the same cell positions.'
    native.container.prepend(nativeLabel)
    native.container.append(referenceLabel, reference)
    await page.screenshot({
      element: native.container,
      path: `../../../.artifacts/canvas-zwj-${name}.png`,
      scale: 'css',
    })

    const nativeRows = native.state.readRows()
    expect(
      nativeRows[0]!.cells
        .filter((cell) => cell.text)
        .map((cell) => cell.text)
        .join(''),
    ).toBe(`A${text}B`)
    expect(nativeRows[0]!.cells[1 + legacySpan]!.text).toBe('B')
    expect(nativeRows[1]!.cells[1]!.text).toBe(text)
    expect(nativeRows[1]!.cells[3]!.text).toBe('B')
    expect(nativeRows[2]!.cells[2]!.continuation).toBe(true)
    expect(nativeRows[2]!.cells[3]!.text).toBe('é')
    expect(nativeRows[2]!.cells[5]!.continuation).toBe(true)
    expect(native.terminal.cursor.x).toBe(9)
    expect(
      differences(pixels(native.canvas, 1), pixels(reference, 1)),
      'known-good mode-2027 whole-cluster control',
    ).toBe(0)
    expect(
      differences(pixels(native.canvas, 2), pixels(reference, 2)),
      'ASCII, CJK, combining, wide emoji and brush controls',
    ).toBe(0)
    expect(
      differences(pixels(native.canvas, 0), pixels(reference, 0)),
      'legacy owners paint separately without moving subsequent text',
    ).toBe(0)
  },
)

interface ExpectedGlyph {
  text: string
  column: number
  span?: number
  row?: number
  font?: string
  foreground?: string
  alpha?: number
}

function glyphOracle(glyphs: readonly ExpectedGlyph[]): HTMLCanvasElement {
  const canvas = newCanvas()
  const context = canvas.getContext('2d')!
  context.textAlign = 'center'
  context.textBaseline = 'alphabetic'
  for (const glyph of glyphs) {
    context.font = `${glyph.font ?? '400'} ${font.settings.size}px ${font.settings.family}`
    context.fillStyle = glyph.foreground ?? '#ffffff'
    context.globalAlpha = glyph.alpha ?? 1
    drawText(context, glyph.text, glyph.column, glyph.row ?? 0, glyph.span ?? 1)
  }
  return canvas
}

function background(canvas: HTMLCanvasElement, column: number, span: number, color: string): void {
  const context = canvas.getContext('2d')!
  context.save()
  context.globalCompositeOperation = 'destination-over'
  context.globalAlpha = 1
  context.fillStyle = color
  context.fillRect(
    column * font.deviceCellWidth,
    0,
    span * font.deviceCellWidth,
    font.deviceCellHeight,
  )
  context.restore()
}

it('keeps bold italic faint native owners over a uniform brush', async () => {
  const native = await fixture('\x1b[?25l\x1b[1;3;2mA👩‍💻B')
  const reference = glyphOracle([
    { text: 'A', column: 0, font: 'italic 700', alpha: 0.5 },
    { text: '👩‍', column: 1, span: 2, font: 'italic 700', alpha: 0.5 },
    { text: '💻', column: 3, span: 2, font: 'italic 700', alpha: 0.5 },
    { text: 'B', column: 5, font: 'italic 700', alpha: 0.5 },
  ])
  expect(differences(pixels(native.canvas, 0), pixels(reference, 0))).toBe(0)
})

it.each([
  { name: 'font', left: '1', right: '3', leftFont: '700', rightFont: 'italic 400' },
  { name: 'foreground', left: '38;2;255;0;0', right: '38;2;0;255;0' },
  { name: 'background', left: '48;2;255;0;0', right: '48;2;0;255;0' },
  { name: 'decoration', left: '4', right: '0' },
])('keeps components separate across a $name boundary', async (brush) => {
  const fillText = vi.spyOn(CanvasRenderingContext2D.prototype, 'fillText')
  const native = await fixture(`\x1b[?25lA\x1b[${brush.left}m👩‍\x1b[0;${brush.right}m💻\x1b[0mB`)
  expect(fillText.mock.calls.map(([text]) => text)).toEqual(['A', '👩‍', '💻', 'B'])
  const reference = glyphOracle([
    { text: 'A', column: 0 },
    {
      text: '👩‍',
      column: 1,
      span: 2,
      font: brush.leftFont,
      foreground: brush.name === 'foreground' ? '#ff0000' : '#ffffff',
    },
    {
      text: '💻',
      column: 3,
      span: 2,
      font: brush.rightFont,
      foreground: brush.name === 'foreground' ? '#00ff00' : '#ffffff',
    },
    { text: 'B', column: 5 },
  ])
  if (brush.name === 'background') {
    background(reference, 1, 2, '#ff0000')
    background(reference, 3, 2, '#00ff00')
  }
  if (brush.name === 'decoration') {
    const context = reference.getContext('2d')!
    context.fillStyle = '#ffffff'
    context.fillRect(24, 46, 48, 1)
  }
  expect(differences(pixels(native.canvas, 0), pixels(reference, 0))).toBe(0)
})

it('retains whole and partial selections, cursor overlays and row damage', async () => {
  const native = await fixture('\x1b[?25lA👩‍💻B')
  const selection = new GhosttySelectionGesture(native.terminal)
  cleanups.push(() => selection.dispose())
  const joined = glyphOracle([
    { text: 'A', column: 0 },
    { text: '👩‍', column: 1, span: 2 },
    { text: '💻', column: 3, span: 2 },
    { text: 'B', column: 5 },
  ])
  const initialRows = native.renderer.metrics.paintedRows
  expect(selection.selectRange({ x: 1, y: 0 }, { x: 4, y: 0 }).selectionInstalled).toBe(true)
  native.renderer.notifySelectionChange()
  native.clock.flushFrame()
  background(joined, 1, 4, '#334455')
  expect(selection.getSelection()).toBe('👩‍💻')
  expect(differences(pixels(native.canvas, 0), pixels(joined, 0))).toBe(0)
  expect(native.renderer.metrics.paintedRows).toBe(initialRows + rows)

  selection.selectRange({ x: 3, y: 0 }, { x: 4, y: 0 })
  native.renderer.notifySelectionChange()
  native.clock.flushFrame()
  const split = glyphOracle([
    { text: 'A', column: 0 },
    { text: '👩‍', column: 1, span: 2 },
    { text: '💻', column: 3, span: 2 },
    { text: 'B', column: 5 },
  ])
  background(split, 3, 2, '#334455')
  expect(differences(pixels(native.canvas, 0), pixels(split, 0))).toBe(0)

  selection.clear()
  native.terminal.write('\x1b[1;4H\x1b[?25h')
  native.renderer.notifyWrite()
  native.clock.flushFrame()
  const cursor = glyphOracle([
    { text: 'A', column: 0 },
    { text: '👩‍', column: 1, span: 2 },
    { text: '💻', column: 3, span: 2 },
    { text: 'B', column: 5 },
  ])
  background(cursor, 3, 1, '#eeeeee')
  expect(native.terminal.cursor.x).toBe(3)
  expect(differences(pixels(native.canvas, 0), pixels(cursor, 0))).toBe(0)

  native.terminal.write('\x1b[?25l')
  native.renderer.notifyWrite()
  native.clock.flushFrame()
  const restored = oracle('👩‍💻', 4)
  expect(differences(pixels(native.canvas, 0), pixels(restored, 0))).toBe(0)
  const beforeDamage = native.renderer.metrics.paintedRows
  native.terminal.write('\x1b[2X')
  native.renderer.notifyWrite()
  native.clock.flushFrame()
  const erased = glyphOracle([
    { text: 'A', column: 0 },
    { text: '👩‍', column: 1, span: 2 },
    { text: 'B', column: 5 },
  ])
  expect(differences(pixels(native.canvas, 0), pixels(erased, 0))).toBe(0)
  native.terminal.write('💻')
  native.renderer.notifyWrite()
  native.clock.flushFrame()
  expect(differences(pixels(native.canvas, 0), pixels(restored, 0))).toBe(0)
  expect(native.renderer.metrics.paintedRows).toBe(beforeDamage + 2)
  expect(native.renderer.hasPendingFrame).toBe(false)
  expect(native.renderer.hasPendingTimer).toBe(false)
})

it('keeps wrapped ZWJ components in their native rows and clips at the right edge', async () => {
  const native = await fixture('\x1b[?25l\x1b[1;23H👩‍💻B')
  const reference = glyphOracle([
    { text: '👩‍', column: 22, span: 2 },
    { text: '💻', column: 0, row: 1, span: 2 },
    { text: 'B', column: 2, row: 1 },
  ])
  expect(native.terminal.cursor.x).toBe(3)
  expect(native.terminal.cursor.y).toBe(1)
  expect(differences(pixels(native.canvas, 0), pixels(reference, 0))).toBe(0)
  expect(differences(pixels(native.canvas, 1), pixels(reference, 1))).toBe(0)
})

it('keeps invisible components and unrelated ZWJ text separate', async () => {
  const fillText = vi.spyOn(CanvasRenderingContext2D.prototype, 'fillText')
  const native = await fixture('\x1b[?25lA\x1b[8m👩‍\x1b[0m💻B\r\nA‍B')
  expect(fillText.mock.calls.map(([text]) => text)).toEqual(['A', '💻', 'B', 'A‍', 'B'])
  const reference = glyphOracle([
    { text: 'A', column: 0 },
    { text: '💻', column: 3, span: 2 },
    { text: 'B', column: 5 },
    { text: 'A‍', column: 0, row: 1 },
    { text: 'B', column: 1, row: 1 },
  ])
  expect(differences(pixels(native.canvas, 0), pixels(reference, 0))).toBe(0)
  expect(differences(pixels(native.canvas, 1), pixels(reference, 1))).toBe(0)
})

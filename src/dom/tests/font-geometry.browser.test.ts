import { afterAll, beforeAll, expect, it, onTestFinished } from 'vitest'
import { CanvasRenderer } from 'ghostty-web'
import { GhosttyRuntime } from '../../core/runtime.js'
import { CanvasTerminalRenderer } from '../../render/canvas/renderer.js'
import { TerminalSession } from '../../term/session.js'
import type { TerminalFontSettings } from '../../term/types.js'
import { fitTerminalFont } from '../fit.js'
import { createGhosttyWebGpuTerminalFromSession } from '../terminal.js'

const font: TerminalFontSettings = {
  boldWeight: 700,
  family: 'GeometryTestMono',
  letterSpacing: 0,
  lineHeight: 1.2,
  size: 12,
  weight: 400,
}
let face: FontFace

beforeAll(async () => {
  face = new FontFace(
    font.family,
    `url(${new URL('../../../site/public/fonts/jetbrains-mono-latin-400-normal.woff2', import.meta.url).href})`,
  )
  document.fonts.add(await face.load())
  await document.fonts.ready
  expect(document.fonts.check(`400 12px ${font.family}`)).toBe(true)
})

afterAll(() => {
  document.fonts.delete(face)
})

it('fits the loaded font box before line-height and device-pixel rounding', () => {
  const context = document.createElement('canvas').getContext('2d')!
  context.font = `400 12px ${font.family}`
  const metrics = context.measureText('Mg')
  const advance = context.measureText('M').width
  expect(metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent).toBeGreaterThan(
    metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
  )

  for (const pixelRatio of [1, 1.25, 2]) {
    for (const lineHeight of [1, 1.2]) {
      const fitted = fitTerminalFont(document, { ...font, lineHeight }, pixelRatio)
      const characterHeight = Math.ceil(
        (metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent) * pixelRatio,
      )
      const cellHeight = Math.floor(characterHeight * lineHeight)
      expect(fitted.deviceCharHeight).toBe(characterHeight)
      expect(fitted.deviceCellHeight).toBe(cellHeight)
      expect(fitted.cssCellHeight).toBe(cellHeight / pixelRatio)
      expect(fitted.deviceCharWidth).toBe(Math.floor(advance * pixelRatio))
      expect(fitted.deviceBaseline).toBe(
        Math.round((cellHeight - characterHeight) / 2) +
          Math.ceil(metrics.fontBoundingBoxAscent * pixelRatio),
      )
    }
  }
})

it('keeps the mounted Canvas grid, backing, and painted row boundaries in the fitted units', async () => {
  const runtime = await GhosttyRuntime.create()
  onTestFinished(() => runtime.dispose())
  const host = document.createElement('div')
  host.style.width = '380px'
  host.style.height = '260px'
  document.body.append(host)
  onTestFinished(() => host.remove())
  const session = await TerminalSession.create<Event>({
    appearance: {
      cursor: { blink: false },
      font,
      grid: { columns: 40, rows: 12 },
    },
    runtime: { kind: 'borrowed', runtime },
  })
  const terminal = createGhosttyWebGpuTerminalFromSession(session, {
    autoFit: false,
    fitEnvironment: { getPixelRatio: () => 2 },
    rendererFactory: (options) => CanvasTerminalRenderer.create(options),
  })
  onTestFinished(() => terminal.dispose())
  await terminal.open(host)
  terminal.write('\x1b[?25l\x1b[48;2;0;0;255m' + ' '.repeat(40) + '\x1b[0m\r\nMg')
  await expect.poll(() => terminal.hasPendingFrame).toBe(false)

  for (const lineHeight of [1.2, 1]) {
    terminal.setFont({ lineHeight })
    await expect.poll(() => terminal.hasPendingFrame).toBe(false)
    const fitted = fitTerminalFont(document, { ...font, lineHeight }, 2)
    const canvas = terminal.canvas!
    expect(terminal.appearance.grid).toMatchObject({
      cellHeight: fitted.cssCellHeight,
      cellWidth: fitted.cssCellWidth,
      columns: 40,
      pixelRatio: 2,
      rows: 12,
    })
    expect([canvas.width, canvas.height]).toEqual([
      fitted.deviceCellWidth * 40,
      fitted.deviceCellHeight * 12,
    ])
    expect([canvas.style.width, canvas.style.height]).toEqual([
      `${fitted.cssCellWidth * 40}px`,
      `${fitted.cssCellHeight * 12}px`,
    ])
    const context = canvas.getContext('2d')!
    expect([...context.getImageData(0, fitted.deviceCellHeight - 1, 1, 1).data]).toEqual([
      0, 0, 255, 255,
    ])
    expect([...context.getImageData(0, fitted.deviceCellHeight, 1, 1).data]).not.toEqual([
      0, 0, 255, 255,
    ])
    expect(terminal.visibleLines()[1]).toContain('Mg')
  }
})

it('derives the pinned ghostty-web cell from M ink bounds and its fixed two-pixel padding', () => {
  const canvas = document.createElement('canvas')
  const context = document.createElement('canvas').getContext('2d')!
  context.font = `12px ${font.family}`
  const metrics = context.measureText('M')
  const ascent = metrics.actualBoundingBoxAscent || font.size * 0.8
  const descent = metrics.actualBoundingBoxDescent || font.size * 0.2
  const renderer = new CanvasRenderer(canvas, {
    cursorBlink: false,
    devicePixelRatio: 2,
    fontFamily: font.family,
    fontSize: font.size,
  })
  onTestFinished(() => renderer.dispose())
  expect(renderer.getMetrics()).toEqual({
    baseline: Math.ceil(ascent) + 1,
    height: Math.ceil(ascent + descent) + 2,
    width: Math.ceil(metrics.width),
  })
  renderer.resize(40, 12)
  expect(canvas.height).toBe(renderer.getMetrics().height * 12 * 2)
  expect(canvas.style.height).toBe(`${renderer.getMetrics().height * 12}px`)
})

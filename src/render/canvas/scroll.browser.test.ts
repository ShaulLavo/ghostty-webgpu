import { testFontUrl } from '../../tests/fonts.js'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { frameMetricDeltas } from '../../../bench/comparison-metrics.js'
import { RenderStateDirty } from '../../core/abi.js'
import { GhosttyRuntime } from '../../core/runtime.js'
import { GhosttySelectionGesture } from '../../core/selection.js'
import type { TerminalFittedFont } from '../../term/types.js'
import { canonicalRendererTheme, mergeRendererTheme } from '../config.js'
import { renderCursorState } from '../cursor.js'
import type { CursorStyle, RendererTheme } from '../instances/types.js'
import type { RenderSchedulerClock } from '../scheduler.js'
import { CanvasRowPainter } from './painter.js'
import { CanvasTerminalRenderer } from './renderer.js'
import { ReferenceRenderer } from './tests/reference-renderer.js'

class FrameClock implements RenderSchedulerClock {
  private handle = 0
  readonly frames = new Map<number, () => void>()
  readonly timers = new Map<number, () => void>()
  cancelFrame(handle: number): void {
    this.frames.delete(handle)
  }
  clearTimer(handle: number): void {
    this.timers.delete(handle)
  }
  requestFrame(callback: () => void): number {
    this.frames.set(++this.handle, callback)
    return this.handle
  }
  setTimer(callback: () => void): number {
    this.timers.set(++this.handle, callback)
    return this.handle
  }
  flush(): void {
    const entry = this.frames.entries().next().value
    if (!entry) throw new TypeError('Expected a scheduled frame')
    this.frames.delete(entry[0])
    entry[1]()
  }
  blink(): void {
    const entry = this.timers.entries().next().value
    if (!entry) throw new TypeError('Expected a cursor timer')
    this.timers.delete(entry[0])
    entry[1]()
    this.flush()
  }
}

function font(ratio = 1): TerminalFittedFont {
  return {
    charLeft: 0,
    charTop: 2,
    cssCellHeight: 20,
    cssCellWidth: 10,
    deviceBaseline: 16 * ratio,
    deviceCellHeight: 20 * ratio,
    deviceCellWidth: 10 * ratio,
    deviceCharHeight: 16 * ratio,
    deviceCharWidth: 10 * ratio,
    pixelRatio: ratio,
    settings: {
      boldWeight: 700,
      family: 'CanvasScrollFixture',
      letterSpacing: 0,
      lineHeight: 1.25,
      size: 16,
      weight: 400,
    },
  }
}

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.restoreAllMocks()
})
beforeAll(async () => {
  const face = new FontFace('CanvasScrollFixture', `url(${testFontUrl})`)
  document.fonts.add(await face.load())
})

async function fixture(initial: string, rowCount = 6, pixels = false) {
  const runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 32, rows: rowCount })
  const state = runtime.createRenderState(terminal)
  const canvas = document.createElement('canvas')
  const control = document.createElement('canvas')
  document.body.append(canvas, control)
  const clock = new FrameClock()
  let fitted = font()
  let theme: Partial<RendererTheme> = { background: { r: 13, g: 17, b: 23 } }
  canvas.style.backgroundColor = `rgb(${theme.background!.r}, ${theme.background!.g}, ${theme.background!.b})`
  let phase = true
  let inactive: CursorStyle | undefined
  terminal.write(initial)
  const create = pixels ? ReferenceRenderer.create : CanvasTerminalRenderer.create
  const renderer = await create({
    canvas,
    columns: 32,
    rows: rowCount,
    font: fitted,
    renderState: state,
    schedulerClock: clock,
    theme,
    cursorBlink: true,
    rendererMode: pixels ? 'canvas2d-pixels' : 'canvas2d-fill-text',
  })
  renderer.setFocused(true)
  cleanups.push(() => {
    renderer.dispose()
    state.dispose()
    terminal.dispose()
    runtime.dispose()
    canvas.remove()
    control.remove()
  })
  clock.flush()
  const context = canvas.getContext('2d')!
  const copy = vi.spyOn(context, 'drawImage')
  const text = vi.spyOn(context, 'fillText')
  const clear = vi.spyOn(context, 'clearRect')
  const controlContext = control.getContext('2d', { alpha: true, willReadFrequently: false })!
  const controlText = vi.spyOn(controlContext, 'fillText')
  function parity(label: string): void {
    const repaintCalls = text.mock.calls.length
    const copiedRows = renderer.reuseMetrics.copiedRows
    controlText.mockClear()
    control.width = canvas.width
    control.height = canvas.height
    const painter = new CanvasRowPainter(
      control.getContext('2d', { alpha: true, willReadFrequently: false })!,
      fitted,
      canonicalRendererTheme(mergeRendererTheme(theme)),
    )
    painter.resetContext(fitted)
    const cursor = renderCursorState(state.readCursor(), phase, inactive)
    for (const row of state.readRows()) painter.paint(row, cursor, control.width)
    const actual = context.getImageData(0, 0, canvas.width, canvas.height).data
    const expected = control
      .getContext('2d')!
      .getImageData(0, 0, control.width, control.height).data
    let different = 0
    for (let index = 0; index < actual.length; index++)
      if (actual[index] !== expected[index]) different++
    expect(different, label).toBe(0)
    console.info(
      JSON.stringify({
        proof: label,
        differentBytes: different,
        candidateFillText: repaintCalls,
        independentFullRepaintFillText: controlText.mock.calls.length,
        copiedRows,
      }),
    )
    copy.mockClear()
    text.mockClear()
    clear.mockClear()
  }
  function write(value: string): void {
    terminal.write(value)
    renderer.notifyWrite()
    phase = true
    clock.flush()
  }
  return {
    canvas,
    control,
    terminal,
    state,
    renderer,
    clock,
    copy,
    text,
    clear,
    controlText,
    parity,
    write,
    setFont(value: TerminalFittedFont) {
      fitted = value
      renderer.setFont(value)
      clock.flush()
    },
    setTheme(value: Partial<RendererTheme>) {
      theme = { ...theme, ...value }
      renderer.setTheme(value)
      clock.flush()
    },
    setInactive(value: CursorStyle) {
      inactive = value
      renderer.setInactiveCursorStyle(value)
      renderer.setFocused(false)
      clock.flush()
    },
    blink() {
      phase = !phase
      clock.blink()
    },
  }
}

function lines(unicode = false): string {
  return (
    '\x1b[?25l' +
    Array.from(
      { length: 6 },
      (_, index) => `${index} ${unicode ? '界 é 😀' : 'alpha beta'} ${index}`,
    ).join('\r\n')
  )
}

describe('Canvas scroll reuse on native snapshots', () => {
  it.each([false, true])(
    'self-copies one-row scrolling and paints only the exposed row (unicode=%s)',
    async (unicode) => {
      const f = await fixture(lines(unicode))
      f.parity('initial independent full repaint')
      const damage = vi.spyOn(f.state, 'update')
      const before = { ...f.renderer.metrics }
      f.write(`\r\n6 ${unicode ? '界 é 😀' : 'alpha beta'} 6`)
      expect(damage.mock.results.at(-1)?.value).toBe(RenderStateDirty.Full)
      expect(f.copy).toHaveBeenCalledExactlyOnceWith(f.canvas, 0, 20, 320, 100, 0, 0, 320, 100)
      expect(f.clear).toHaveBeenCalledTimes(1)
      expect(f.text.mock.calls.length).toBeLessThan(25)
      const delta = frameMetricDeltas([before], [{ ...f.renderer.metrics }])[0]!.delta
      expect(f.renderer.metrics).toBe(f.renderer.reuseMetrics)
      expect(delta).toMatchObject({
        copiedRows: 5,
        repaintedRows: 1,
        selfCopies: 1,
        paintedRows: 6,
        submittedFrames: 1,
      })
      const candidateGlyphs = f.text.mock.calls.length
      expect(f.renderer.reuseMetrics).toMatchObject({
        copiedRows: 5,
        repaintedRows: 7,
        selfCopies: 1,
      })
      f.parity('one-row scroll full-frame pixels')
      const fullGlyphs = f.controlText.mock.calls.length
      expect(candidateGlyphs * 6).toBe(fullGlyphs)
      await page.screenshot({
        element: f.canvas,
        path: `../../../.artifacts/canvas-scroll-${unicode ? 'unicode' : 'ascii'}-copied5-painted1-glyphs${candidateGlyphs}-full${fullGlyphs}-parity0.png`,
      })
    },
  )

  it('handles multi-row/reverse scroll, changed prompts, rewrites, and stationary frames', async () => {
    const f = await fixture(lines())
    f.parity('initial')
    f.write('\x1b[2S\x1b[6;1Hexposed')
    expect(f.copy).toHaveBeenCalledOnce()
    expect(f.clear.mock.calls.length).toBeLessThan(6)
    f.parity('two-row scroll')
    f.write('\x1b[2T\x1b[1;1Hreverse')
    expect(f.copy).toHaveBeenCalledOnce()
    f.parity('reverse scroll')
    f.write('\x1b[1S\x1b[3;1Hprompt changed\x1b[6;1Hnew')
    expect(f.copy).toHaveBeenCalledOnce()
    f.parity('shift plus changed prompt')
    f.write('\x1b[2;1Hrewrite unrelated content')
    expect(f.copy).not.toHaveBeenCalled()
    f.parity('unrelated content rewrite')
    f.renderer.schedule()
    f.clock.flush()
    expect(f.copy).not.toHaveBeenCalled()
    expect(f.clear).not.toHaveBeenCalled()
    f.parity('no scroll/no damage')
  })

  it('removes the transported old cursor and preserves cursor styles, movement, and blink', async () => {
    const f = await fixture(lines() + '\x1b[?25h\x1b[3;4H')
    f.parity('cursor before scroll')
    expect(f.canvas.getContext('2d')!.getImageData(31, 41, 1, 1).data[3]).toBe(255)
    f.write('\x1b[1S\x1b[6;1Htail\x1b[4;7H')
    expect(f.copy).toHaveBeenCalledOnce()
    expect(f.clear.mock.calls.length).toBeLessThan(6)
    expect(f.canvas.getContext('2d')!.getImageData(31, 21, 1, 1).data[3]).toBe(0)
    f.parity('transported old cursor absent across full frame')
    for (const style of [1, 3, 5]) {
      f.write(`\x1b[${style} q\x1b[2;9H`)
      f.parity(`cursor style ${style}`)
      f.blink()
      f.parity(`cursor blink hidden ${style}`)
      f.blink()
      f.parity(`cursor blink visible ${style}`)
    }
    f.setInactive('outline')
    f.parity('inactive outline')
    f.write('\x1b[1S\x1b[6;1Htail2')
    f.parity('outline cursor scroll')
  })

  it('preserves styled native rows and selection screen coordinates', async () => {
    const styled = Array.from(
      { length: 6 },
      (_, i) => `\x1b[48;2;${30 + i};40;50m\x1b[1;3;4;9m${i} 界 é 😀\x1b[0m`,
    ).join('\r\n')
    const f = await fixture('\x1b[?25l' + styled)
    f.parity('styled backgrounds/wide/combining/emoji')
    f.write('\r\n\x1b[2;4:3mnew 界 é 😀\x1b[0m')
    expect(f.copy).toHaveBeenCalledOnce()
    f.parity('styled scroll')
    const selection = new GhosttySelectionGesture(f.terminal)
    cleanups.push(() => selection.dispose())
    selection.selectLines(1, 2)
    f.renderer.notifySelectionChange()
    f.clock.flush()
    expect(f.copy).not.toHaveBeenCalled()
    expect(f.state.readRows().some((row) => row.cells.some((cell) => cell.selected))).toBe(true)
    f.parity('native selection')
    f.write('\x1b[1S\x1b[6;1Hselected scroll')
    f.parity('native selection scroll')
    selection.clear()
    f.renderer.notifySelectionChange()
    f.clock.flush()
    f.parity('selection cleared')
  })

  it('reuses viewport shifts and resets for resize, font/DPR, theme, atlas, clear, and alternate buffer', async () => {
    const f = await fixture(lines() + '\r\nextra history\r\nmore history')
    f.parity('initial with scrollback')
    f.terminal.scrollBy(-1)
    f.renderer.notifyScroll()
    f.clock.flush()
    expect(f.copy).toHaveBeenCalledOnce()
    expect(f.clear).toHaveBeenCalledOnce()
    f.parity('scrollback viewport up')
    f.terminal.scrollToBottom()
    f.renderer.notifyScroll()
    f.clock.flush()
    f.parity('scrollback bottom')
    f.setFont(font(2))
    expect(f.copy).not.toHaveBeenCalled()
    f.parity('DPR change')
    f.setFont({ ...font(), settings: { ...font().settings, size: 15 } })
    f.parity('font change')
    f.setTheme({ foreground: { r: 12, g: 200, b: 130 }, background: { r: 2, g: 3, b: 5 } })
    expect(f.copy).not.toHaveBeenCalled()
    f.parity('theme change')
    const beforeReset = { ...f.renderer.metrics }
    f.renderer.clearTextureAtlas()
    expect(f.renderer.metrics).toEqual(beforeReset)
    f.clock.flush()
    expect(f.renderer.metrics.repaintedRows - beforeReset.repaintedRows).toBe(6)
    expect(f.renderer.metrics.copiedRows).toBe(beforeReset.copiedRows)
    expect(f.copy).not.toHaveBeenCalled()
    expect(f.clear.mock.calls).toEqual([[0, 0, f.canvas.width, f.canvas.height]])
    f.parity('explicit reset')
    f.terminal.resize({ columns: 32, rows: 7 })
    f.renderer.resize({ columns: 32, rows: 7 })
    expect(f.copy).not.toHaveBeenCalled()
    f.parity('resize')
    f.write('\x1b[?1049halt buffer\r\nsecond')
    f.parity('alternate buffer')
    f.write('\x1b[?1049l')
    f.parity('primary restored')
    f.write('\x1b[2J\x1b[H')
    f.parity('clear')
  })
})

it.each(['copy', 'paint'])(
  'invalidates a partially changed image after a %s failure',
  async (failure) => {
    const f = await fixture(lines())
    f.parity('initial before failure')
    const context = f.canvas.getContext('2d')!
    const acknowledged = vi.spyOn(f.state, 'acknowledge')
    const before = { ...f.renderer.metrics }
    if (failure === 'copy') {
      f.copy.mockImplementationOnce((...args) => {
        Reflect.apply(CanvasRenderingContext2D.prototype.drawImage, context, args)
        throw new TypeError('Injected Canvas copy failure')
      })
    } else {
      let saves = 0
      vi.spyOn(context, 'save').mockImplementation(() => {
        saves++
        if (saves === 2) throw new TypeError('Injected Canvas paint failure')
        CanvasRenderingContext2D.prototype.save.call(context)
      })
    }
    expect(() => f.write('\r\nnext line')).toThrow('Injected Canvas')
    expect(acknowledged).not.toHaveBeenCalled()
    expect(f.renderer.metrics.repaintedRows).toBe(before.repaintedRows)
    expect(f.renderer.metrics.selfCopies - before.selfCopies).toBe(failure === 'copy' ? 0 : 1)
    expect(f.renderer.metrics.copiedRows - before.copiedRows).toBe(failure === 'copy' ? 0 : 5)
    expect(f.renderer.metrics.submittedFrames).toBe(before.submittedFrames)
    f.clear.mockClear()
    f.copy.mockClear()
    f.renderer.notifyWrite()
    f.clock.flush()
    expect(f.copy).not.toHaveBeenCalled()
    expect(f.clear.mock.calls).toEqual([[0, 0, f.canvas.width, f.canvas.height]])
    expect(acknowledged).toHaveBeenCalledOnce()
    f.parity('complete repaint after failed frame')
  },
)

it('keeps partial damage reads, native revision, and acknowledgement semantics', async () => {
  const f = await fixture(lines())
  f.parity('initial partial-damage case')
  const read = vi.spyOn(f.state, 'readRows')
  const update = vi.spyOn(f.state, 'update')
  const acknowledged = vi.spyOn(f.state, 'acknowledge')
  const version = f.state.snapshotVersion
  f.write('\bX')
  expect(update).toHaveBeenCalledOnce()
  expect(read).toHaveBeenCalledExactlyOnceWith({ dirtyOnly: true, packed: true })
  expect(acknowledged).toHaveBeenCalledOnce()
  expect(f.state.snapshotVersion).toBe(version + 1)
  expect(f.copy).not.toHaveBeenCalled()
  expect(f.clear).toHaveBeenCalledOnce()
  f.parity('partial damage exact pixels')
  f.renderer.refreshRows(0, 0)
  f.clock.flush()
  expect(f.clear).toHaveBeenCalledOnce()
  f.parity('explicit refresh forces painting')
})

it.each(['fill-text', 'pixels'] as const)(
  'reuses native rows on an OffscreenCanvas (%s)',
  async (mode) => {
    const runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 32, rows: 6 })
    const state = runtime.createRenderState(terminal)
    const canvas = new OffscreenCanvas(1, 1)
    const control = new OffscreenCanvas(1, 1)
    const clock = new FrameClock()
    terminal.write(lines())
    const create = mode === 'pixels' ? ReferenceRenderer.create : CanvasTerminalRenderer.create
    const renderer = await create({
      canvas,
      columns: 32,
      rows: 6,
      font: font(),
      renderState: state,
      schedulerClock: clock,
      rendererMode: mode === 'pixels' ? 'canvas2d-pixels' : 'canvas2d-fill-text',
    })
    cleanups.push(() => {
      renderer.dispose()
      state.dispose()
      terminal.dispose()
      runtime.dispose()
    })
    clock.flush()
    terminal.write('\r\nOffscreen next')
    renderer.notifyWrite()
    clock.flush()
    expect(renderer.canvasPaintMode).toBe(mode)
    expect(renderer.metrics.repaintedRows).toBe(7)
    expect(renderer.reuseMetrics).toMatchObject({ copiedRows: 5, selfCopies: 1 })
    if (mode === 'pixels')
      expect(renderer.pixelMetrics).toMatchObject({ bufferMoves: 1, movedRows: 5 })
    control.width = canvas.width
    control.height = canvas.height
    const context = control.getContext('2d', { alpha: true, willReadFrequently: false })!
    const painter = new CanvasRowPainter(
      context,
      font(),
      canonicalRendererTheme(mergeRendererTheme({})),
    )
    painter.resetContext(font())
    for (const row of state.readRows()) painter.paint(row, undefined, control.width)
    const actual = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    const expected = context.getImageData(0, 0, control.width, control.height).data
    expect(actual).toEqual(expected)
  },
)

it('verifies equal-looking rows across alternate buffers and repeated clear/reset transitions', async () => {
  const repeated = '\x1b[?25l' + Array.from({ length: 6 }, () => 'same row 界 e\u0301').join('\r\n')
  const f = await fixture(repeated)
  f.parity('primary repeated rows')
  f.write('\x1b[?1049h' + repeated)
  f.parity('alternate identical repeated rows')
  f.write('\x1b[?25h\x1b[3;5H\x1b[1S')
  f.parity('alternate repeated row cursor')
  f.write('\x1b[?1049l')
  f.parity('restore repeated primary rows')
  for (let repeat = 0; repeat < 2; repeat++) {
    f.write('\x1b[2J\x1b[H\x1b[48;2;7;12;19mcolored blank\x1b[0m')
    f.parity(`clear/rewrite with changed background ${repeat}`)
    f.write('\x1bc')
    f.parity(`terminal reset ${repeat}`)
  }
})

describe('Canvas pixel presentation on current native snapshots', () => {
  it('presents every styled/grapheme/primitive frame with exact transparent pixels', async () => {
    const f = await fixture('\x1b[?25l', 6, true)
    const upload = vi.spyOn(f.canvas.getContext('2d')!, 'putImageData')
    const streams = [
      'Ag black \x1b[38;2;255;0;0mAg red\x1b[0m',
      '\r\n\x1b[1;3mBold italic\x1b[0m \x1b[2mfaint\x1b[0m',
      '\r\n\x1b[4:1mone\x1b[4:2mtwo\x1b[4:3mwave\x1b[4:4mdot\x1b[4:5mdash\x1b[0m',
      '\r\n\x1b[53;9mover strike\x1b[0m \x1b[7minverse\x1b[0m \x1b[8mhidden\x1b[0m',
      '\r\n界 é 😀 👩‍💻 👨‍👩‍👧',
      '\x1b[2;1H\x1b[48;2;17;35;63m\x1b[4:3mbackground wave\x1b[0m',
      '\x1b[?25h\x1b[1 q\x1b[3;4H',
      '\x1b[3 q\x1b[4;6H',
      '\x1b[5 q\x1b[5;8H',
      '\x1b[2J\x1b[Hclear to transparent',
    ]
    expect(f.renderer.canvasPaintMode).toBe('pixels')
    f.parity('pixels initial transparent frame')
    for (const [index, value] of streams.entries()) {
      f.write(value)
      f.parity(`pixels streamed native frame ${index}`)
      if (index === 5)
        await page.screenshot({
          element: f.canvas,
          path: '../../../.artifacts/canvas-pixels-styled-zwj-parity0.png',
        })
    }
    f.blink()
    f.parity('pixels cursor blink hidden')
    f.blink()
    f.parity('pixels cursor blink visible')
    f.setInactive('outline')
    f.parity('pixels inactive outline')
    const selection = new GhosttySelectionGesture(f.terminal)
    cleanups.push(() => selection.dispose())
    selection.selectLines(0, 2)
    f.renderer.notifySelectionChange()
    f.clock.flush()
    f.parity('pixels native selection')
    selection.clear()
    f.renderer.notifySelectionChange()
    f.clock.flush()
    f.parity('pixels native selection erased')
    expect(upload).toHaveBeenCalled()
    expect(f.text).not.toHaveBeenCalled()
    await page.screenshot({
      element: f.canvas,
      path: '../../../.artifacts/canvas-pixels-native-parity0.png',
    })
  })

  it('transports retained pixels and keeps font/DPR/theme/resize/reset coverage exact', async () => {
    const f = await fixture(lines(true), 6, true)
    const upload = vi.spyOn(f.canvas.getContext('2d')!, 'putImageData')
    const reads = vi.spyOn(f.state, 'readRows')
    const acknowledge = vi.spyOn(f.state, 'acknowledge')
    const before = { ...f.renderer.metrics }
    f.write('\r\nnext 界 👩‍💻')
    expect(reads).toHaveBeenCalledExactlyOnceWith({ dirtyOnly: true, packed: false })
    expect(acknowledge).toHaveBeenCalledOnce()
    expect(f.renderer.pixelMetrics.bufferMoves - before.bufferMoves).toBe(1)
    expect(f.renderer.pixelMetrics.movedRows - before.movedRows).toBe(5)
    expect(f.renderer.metrics.repaintedRows - before.repaintedRows).toBe(1)
    expect(f.renderer.pixelMetrics.rasterReadbackBytes - before.rasterReadbackBytes).toBe(
      320 * 20 * 4,
    )
    expect(f.renderer.pixelMetrics.uploadedPixelBytes - before.uploadedPixelBytes).toBe(
      320 * 120 * 4,
    )
    f.parity('pixels shifted full native snapshot')
    f.write('\x1b[2T\x1b[1;1Hreverse')
    f.parity('pixels reverse memmove')
    f.write('\x1b[?25h\x1b[3;4H\x1b[1S')
    f.parity('pixels transported cursor')
    f.setTheme({ foreground: { r: 151, g: 77, b: 33 }, minimumContrast: 7 })
    f.parity('pixels brush/contrast changed')
    f.setFont({ ...font(), deviceCellWidth: 11, deviceCharWidth: 10 })
    f.parity('pixels half-pixel center phase')
    f.setFont({ ...font(), settings: { ...font().settings, size: 40 } })
    f.parity('pixels tall glyph row clip')
    f.setFont(font(2))
    f.parity('pixels DPR two')
    f.terminal.resize({ columns: 32, rows: 8 })
    f.renderer.resize({ columns: 32, rows: 8 })
    f.parity('pixels viewport resize')
    f.write('\x1b[?1049h\x1b[2J\x1b[Halternate')
    f.parity('pixels alternate buffer')
    f.write('\x1b[?1049l\x1bc')
    f.parity('pixels reset primary')
    f.renderer.clearTextureAtlas()
    f.clock.flush()
    f.parity('pixels explicit cache clear')
    expect(upload).toHaveBeenCalled()
    expect(f.copy).not.toHaveBeenCalled()
  })
})

it('refills moved pixel rows after a raster readback failure without acknowledging damage', async () => {
  const f = await fixture(lines(true), 6, true)
  f.parity('pixels before failed raster')
  const acknowledged = vi.spyOn(f.state, 'acknowledge')
  const before = { ...f.renderer.metrics }
  const readback = vi.spyOn(CanvasRenderingContext2D.prototype, 'getImageData')
  readback.mockImplementationOnce(() => {
    throw new TypeError('Injected pixel readback failure')
  })
  expect(() => f.write('\r\nfailed raster 界')).toThrow('Injected pixel readback failure')
  expect(acknowledged).not.toHaveBeenCalled()
  expect(f.renderer.metrics.submittedFrames).toBe(before.submittedFrames)
  expect(f.renderer.pixelMetrics.bufferMoves - before.bufferMoves).toBe(1)
  readback.mockRestore()
  f.renderer.notifyWrite()
  f.clock.flush()
  expect(acknowledged).toHaveBeenCalledOnce()
  expect(f.renderer.metrics.repaintedRows - before.repaintedRows).toBe(6)
  f.parity('pixels complete refill after failed raster')
})

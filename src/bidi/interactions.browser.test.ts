import { page } from 'vitest/browser'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import selection from '../../bench/fixtures/correctness/bidi-selection.vt?raw'
import word from '../../bench/fixtures/correctness/bidi-word-selection.vt?raw'
import link from '../../bench/fixtures/correctness/bidi-link.vt?raw'
import mouse from '../../bench/fixtures/correctness/bidi-mouse.vt?raw'
import wide from '../../bench/fixtures/correctness/bidi-wide-emoji.vt?raw'
import { Terminal as MainTerminal } from '../dom/terminal.js'
import { WebGlTerminalRenderer } from '../render/webgl/renderer.js'
import { CanvasTerminalRenderer } from '../render/canvas/renderer.js'
import { Terminal as WorkerTerminal, TerminalWorkerError } from '../../dist/worker/index.js'
import type { TerminalApi } from '../dom/terminal-api.js'
import { testFontUrl } from '../tests/fonts.js'
import { workerWebglSkipReason } from './tests/browser-capabilities.js'

const family = 'BidiInteractionTest'
const face = new FontFace(family, `url(${testFontUrl})`)
const active: TerminalApi[] = []
const roots: HTMLElement[] = []
let webglSkipReason: string | undefined
beforeAll(async () => {
  document.fonts.add(await face.load())
  webglSkipReason = await workerWebglSkipReason()
})
afterEach(async () => {
  for (const terminal of active.splice(0)) await terminal.dispose()
  for (const root of roots.splice(0)) root.remove()
})
afterAll(() => {
  document.fonts.delete(face)
})

async function create(mode: string, input: string) {
  const activations: string[] = []
  const options = {
    accessibility: {},
    bidi: true,
    appearance: { font: { family, size: 16 }, cursor: { blink: false } },
    links: {
      activateUri: (uri: string) => {
        activations.push(uri)
      },
    },
  }
  let terminal: TerminalApi
  if (mode === 'main' || mode === 'main-webgl')
    terminal = await MainTerminal.create({
      ...options,
      rendererFactory: (options) =>
        mode === 'main'
          ? CanvasTerminalRenderer.create(options)
          : WebGlTerminalRenderer.create(options),
    })
  else
    terminal = await WorkerTerminal.create({
      ...options,
      backend: mode === 'webgpu' ? 'webgpu' : 'webgl',
      fonts: [{ family, source: { url: testFontUrl } }],
      assets: {
        wasm: new URL('../../ghostty-vt.wasm', import.meta.url).href,
        bridge: new URL('../../bridge.wasm', import.meta.url).href,
      },
    })
  active.push(terminal)
  const root = document.createElement('div')
  root.style.cssText = 'position:relative;width:480px;height:160px'
  document.body.append(root)
  roots.push(root)
  try {
    await terminal.open(root)
  } catch (cause) {
    if (cause instanceof TerminalWorkerError)
      throw new Error(`${cause.operation}: ${JSON.stringify(cause.internal)}`, { cause })
    throw cause
  }
  if (mode === 'main-webgl') expect(terminal.diagnostics.rendererBackend).toBe('webgl2')
  terminal.canvas!.style.backgroundColor = 'rgb(17,17,17)'
  await terminal.write(input)
  await expect.poll(() => terminal.submittedFrame).not.toBeUndefined()
  await expect.poll(() => terminal.visibleLines()[0]?.trimEnd()).toBeTruthy()
  return { terminal, root, activations }
}

function pointer(terminal: TerminalApi, type: string, column: number, buttons = 0): void {
  const canvas = terminal.canvas!
  const frame = terminal.submittedFrame!
  const bounds = canvas.getBoundingClientRect()
  canvas.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      buttons,
      clientX: bounds.left + frame.padding.left + (column + 0.5) * frame.grid.cellWidth,
      clientY: bounds.top + frame.padding.top + 0.5 * frame.grid.cellHeight,
    }),
  )
}

async function drag(terminal: TerminalApi, start: number, end: number): Promise<void> {
  pointer(terminal, 'pointerdown', start, 1)
  pointer(terminal, 'pointermove', end, 1)
  pointer(terminal, 'pointerup', end)
  await expect.poll(() => terminal.getSelection()).not.toBeUndefined()
}

async function assertHighlight(terminal: TerminalApi, selected: readonly number[]): Promise<void> {
  const canvas = terminal.canvas!
  const image = new Image()
  image.src = `data:image/png;base64,${await page.screenshot({ element: canvas, save: false, scale: 'css' })}`
  await image.decode()
  const decoded = document.createElement('canvas')
  decoded.width = image.naturalWidth
  decoded.height = image.naturalHeight
  const context = decoded.getContext('2d')!
  context.drawImage(image, 0, 0)
  const { grid, padding } = terminal.submittedFrame!
  for (let column = 0; column < 10; column += 1) {
    const x = Math.floor(padding.left + (column + 0.5) * grid.cellWidth)
    const y = Math.floor(padding.top + 1)
    const pixel = Array.from(context.getImageData(x, y, 1, 1).data).slice(0, 3)
    expect(pixel, `visual highlight ${column}`).toEqual(
      selected.includes(column) ? [51, 68, 85] : [17, 17, 17],
    )
  }
}

function selectedColumns(text: string): number[] {
  if (text === 'b ם') return [1, 2, 6]
  if (text === 'שלום') return [3, 4, 5, 6]
  return [1, 2, 3, 4, 5, 6, 7, 8]
}

function snapshotColumns(snapshot: Awaited<ReturnType<TerminalApi['frameSnapshot']>>) {
  return snapshot?.rows[0]?.renderCells.filter((cell) => cell.selected).map((cell) => cell.x)
}

function clearBeforeMainFrame(terminal: MainTerminal): number {
  const submitted = terminal.submittedFrame!
  terminal.clearSelection()
  expect(terminal.getSelection()).toBeUndefined()
  const snapshot = terminal.frameSnapshot()
  expect(snapshot).toBeDefined()
  expect(terminal.submittedFrame!.frame).toBe(submitted.frame)
  expect(snapshot!.rows[0]!.text.trimEnd()).toBe('ab שלום cd')
  expect(snapshotColumns(snapshot)).toEqual([1, 2, 6])
  return submitted.frame
}

async function workerVisibility(terminal: TerminalApi, visible: boolean): Promise<void> {
  const execution: unknown = Reflect.get(terminal, 'execution')
  if (typeof execution !== 'object' || execution === null || !('request' in execution))
    throw new Error('Worker execution request is missing')
  const request = execution.request
  if (typeof request !== 'function') throw new Error('Worker execution request is not callable')
  await request.call(execution, 'visible', [visible])
}

async function clearBeforeWorkerFrame(terminal: TerminalApi): Promise<number> {
  await workerVisibility(terminal, false)
  try {
    const submitted = terminal.submittedFrame!
    const before = await terminal.frameSnapshot()
    expect(before).toBeDefined()
    expect(before!.rows[0]!.text.trimEnd()).toBe('ab שלום cd')
    expect(snapshotColumns(before)).toEqual([1, 2, 6])
    await terminal.clearSelection()
    expect(await terminal.getSelection()).toBeUndefined()
    const snapshot = await terminal.frameSnapshot()
    expect(snapshot).toBeDefined()
    expect(terminal.submittedFrame!.frame).toBe(submitted.frame)
    expect(terminal.submittedFrame!.snapshotVersion).toBe(submitted.snapshotVersion)
    expect(snapshot!.cursor).toEqual(before!.cursor)
    expect(snapshot!.rows[0]!.text.trimEnd()).toBe('ab שלום cd')
    expect(snapshotColumns(snapshot), 'paused submitted membership').toEqual([1, 2, 6])
    return submitted.frame
  } finally {
    await workerVisibility(terminal, true)
  }
}

describe.each(['main', 'main-webgl', 'webgl', 'webgpu'])('BiDi %s interactions', (mode) => {
  const test = it.skipIf(mode === 'webgpu' && !navigator.gpu)
  beforeEach(({ skip }) => {
    if (mode === 'webgl' && webglSkipReason) skip(webglSkipReason)
  })
  test.each([
    [1, 8, 'b שלום c'],
    [8, 1, 'b שלום c'],
    [3, 6, 'שלום'],
    [3, 1, 'b ם'],
  ])('copies visual drag %i to %i in logical order', async (start, end, text) => {
    const { terminal, root } = await create(mode, selection)
    await drag(terminal, start, end)
    await expect.poll(() => terminal.getSelection()).toBe(text)
    expect(terminal.visibleLines()[0]?.trimEnd()).toBe('ab שלום cd')
    expect(root.querySelector('.ghostty-webgpu-accessibility')?.textContent).toContain('ab שלום cd')
    const expected = selectedColumns(text)
    await expect
      .poll(async () =>
        (await terminal.frameSnapshot())?.rows[0]?.renderCells
          .filter((cell) => cell.selected)
          .map((cell) => cell.x),
      )
      .toEqual(expected)
    expect((await terminal.frameSnapshot())?.rows[0]?.text).toContain('ab שלום cd')
    await assertHighlight(
      terminal,
      Array.from({ length: Math.abs(end - start) + 1 }, (_, i) => Math.min(start, end) + i),
    )
  })
  test('keeps the submitted selection between clear and the next frame', async () => {
    const { terminal } = await create(mode, selection)
    if (mode === 'webgl') expect(terminal.diagnostics.rendererBackend).toBe('webgl2')
    if (mode === 'webgpu') expect(terminal.diagnostics.rendererBackend).toBe('webgpu')
    await drag(terminal, 3, 1)
    await expect
      .poll(async () => snapshotColumns(await terminal.frameSnapshot()))
      .toEqual([1, 2, 6])
    await assertHighlight(terminal, [1, 2, 3])
    const frame =
      terminal instanceof MainTerminal
        ? clearBeforeMainFrame(terminal)
        : await clearBeforeWorkerFrame(terminal)
    await expect.poll(() => terminal.submittedFrame!.frame).toBeGreaterThan(frame)
    await expect.poll(async () => snapshotColumns(await terminal.frameSnapshot())).toEqual([])
    await assertHighlight(terminal, [])
  })
  test('refreshes an empty hold without changing captured membership or version', async () => {
    const { terminal } = await create(mode, selection)
    await drag(terminal, 3, 1)
    await expect
      .poll(async () => snapshotColumns(await terminal.frameSnapshot()))
      .toEqual([1, 2, 6])
    await terminal.write('\x1b[?2026h')
    await terminal.refresh(0, terminal.submittedFrame!.grid.rows - 1)
    await expect.poll(async () => (await terminal.frameSnapshot())?.renderHeld).toBe(true)
    const version = terminal.submittedFrame!.snapshotVersion
    await terminal.write('\x1b[?2026l')
    await expect.poll(async () => (await terminal.frameSnapshot())?.renderHeld).toBe(false)
    expect(terminal.submittedFrame!.snapshotVersion).toBe(version)
    expect(snapshotColumns(await terminal.frameSnapshot())).toEqual([1, 2, 6])
    await assertHighlight(terminal, [1, 2, 3])
  })
  test('keeps held selection paint and releases to the current selection', async () => {
    const { terminal } = await create(mode, selection)
    await drag(terminal, 3, 1)
    await expect
      .poll(async () =>
        (await terminal.frameSnapshot())?.rows[0]?.renderCells
          .filter((cell) => cell.selected)
          .map((cell) => cell.x),
      )
      .toEqual([1, 2, 6])
    await assertHighlight(terminal, [1, 2, 3])
    const visible = terminal.visibleLines()
    const rows = terminal.submittedFrame!.grid.rows
    await terminal.write('\x1b[?2026h' + '\r\n'.repeat(rows + 1))
    await terminal.refresh(0, rows - 1)
    expect(terminal.visibleLines()).toEqual(visible)
    expect(
      (await terminal.frameSnapshot())?.rows[0]?.renderCells
        .filter((cell) => cell.selected)
        .map((cell) => cell.x),
    ).toEqual([1, 2, 6])
    expect(await terminal.getSelection()).toBe('b ם')
    await assertHighlight(terminal, [1, 2, 3])
    await terminal.clearSelection()
    expect(await terminal.getSelection()).toBeUndefined()
    await assertHighlight(terminal, [1, 2, 3])
    await terminal.write('\x1b[?2026l')
    await expect.poll(() => terminal.visibleLines()[0]?.trimEnd()).toBe('')
    await expect
      .poll(async () =>
        (await terminal.frameSnapshot())?.rows.flatMap((row) =>
          row.renderCells.filter((cell) => cell.selected).map((cell) => cell.x),
        ),
      )
      .toEqual([])
    await assertHighlight(terminal, [])
  })
  test('uses logical word boundaries and programmatic ranges', async () => {
    const { terminal } = await create(mode, word)
    pointer(terminal, 'pointerdown', 3, 1)
    pointer(terminal, 'pointerup', 3)
    pointer(terminal, 'pointerdown', 3, 1)
    pointer(terminal, 'pointerup', 3)
    await expect.poll(() => terminal.getSelection()).toBe('אa')
    await terminal.write(`\r\x1b[2K${selection}`)
    await terminal.selectRange({ x: 3, y: 0 }, { x: 6, y: 0 })
    expect(await terminal.getSelection()).toBe('שלום')
  })
  test('maps OSC 8 hover and paints the logical link cells', async () => {
    const { terminal, root, activations } = await create(mode, link)
    for (const column of [3, 4, 5, 6]) {
      pointer(terminal, 'pointermove', column)
      await expect
        .poll(() => root.querySelector('[role="link"]')?.getAttribute('aria-label'))
        .toBe('שלום')
    }
    const overlay = root.querySelector<HTMLElement>('[role="link"]')!
    expect(
      Array.from(
        overlay.children,
        (child) =>
          Number.parseFloat(overlay.style.left) +
          Number.parseFloat((child as HTMLElement).style.left),
      ).sort((a, b) => a - b),
    ).toEqual(
      [3, 4, 5, 6].map((x) => expect.closeTo(x * terminal.submittedFrame!.grid.cellWidth, 5)),
    )
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await expect.poll(() => activations).toEqual(['https://example.test'])
    await terminal.write('\x1b[1;10HX')
    await expect.poll(() => terminal.visibleLines()[0]?.trimEnd()).toBe('ab שלום cX')
    pointer(terminal, 'pointermove', 3)
    await expect
      .poll(() => root.querySelector('[role="link"]')?.getAttribute('aria-label'))
      .toBe('שלום')
  })
  test('reports logical SGR columns and stops after mouse tracking is disabled', async () => {
    const { terminal } = await create(mode, mouse)
    const reports: string[] = []
    terminal.on('data', (event) => reports.push(new TextDecoder().decode(event.bytes)))
    pointer(terminal, 'pointerdown', 3, 1)
    pointer(terminal, 'pointermove', 4, 1)
    pointer(terminal, 'pointerup', 3)
    await expect.poll(() => reports).toEqual(['\x1b[<0;7;1M', '\x1b[<32;6;1M', '\x1b[<0;7;1m'])
    await terminal.write('\x1b[?1002l')
    pointer(terminal, 'pointerdown', 3, 1)
    pointer(terminal, 'pointerup', 3)
    expect(reports).toHaveLength(3)
  })
  test('maps both columns of a wide glyph for application mouse reports', async () => {
    const { terminal } = await create(mode, wide)
    await terminal.write('\x1b[?1002h\x1b[?1006h')
    const reports: string[] = []
    terminal.on('data', (event) => reports.push(new TextDecoder().decode(event.bytes)))
    for (const column of [2, 3]) {
      pointer(terminal, 'pointerdown', column, 1)
      pointer(terminal, 'pointerup', column)
    }
    await expect
      .poll(() => reports)
      .toEqual(['\x1b[<0;3;1M', '\x1b[<0;3;1m', '\x1b[<0;4;1M', '\x1b[<0;4;1m'])
  })
})

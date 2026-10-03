import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { GhosttyRuntime } from '../../core/runtime.js'
import type { TerminalScrollbar } from '../../core/types.js'
import { GlyphAtlas } from '../../render/atlas/atlas.js'
import type { CanvasGlyphRasterizer } from '../../render/atlas/canvas-rasterizer.js'
import { AtlasGpuTextures } from '../../render/atlas/gpu-textures.js'
import { WebGpuTerminalRenderer } from '../../render/renderer.js'
import { WebGlTerminalRenderer } from '../../render/webgl/renderer.js'
import { WebGlTextPass } from '../../render/webgl/text-pass.js'
import { displayedPixels } from '../../render/webgl/tests/fixture.js'
import type { RenderScheduler } from '../../render/scheduler.js'
import type { WebGpuTextPass } from '../../render/text-pass.js'
import type {
  RendererFrameSnapshot,
  RendererGridSize,
  RendererTextFrameSnapshot,
  WebGpuTerminalRendererOptions,
} from '../../render/renderer.js'
import type { ProvidedLink } from '../../term/links.js'
import { TerminalSession } from '../../term/session.js'
import type { TerminalFittedFont, TerminalSessionOptions } from '../../term/types.js'
import {
  createTerminalAccessibility,
  type TerminalAccessibilityController,
} from '../accessibility.js'
import { createDomClipboardPolicyAdapter } from '../clipboard.js'
import { fitTerminalFont } from '../fit.js'
import { createDomLinkController, type DomLinkController } from '../links.js'
import type { CommittedPointerLayout } from '../pointer.js'
import { createTerminalScrollbar, type TerminalScrollbarClock } from '../scrollbar.js'
import { Terminal } from '../terminal.js'
import type { GhosttyWebGpuRenderer, GhosttyWebGpuTerminalOptions } from '../types.js'

const decoder = new TextDecoder()
const escape = '\u001b'
const cleanups: Array<() => void> = []

interface Deferred<T> {
  readonly promise: Promise<T>
  reject(cause: unknown): void
  resolve(value: T): void
}

interface LinkHarness {
  readonly canvas: HTMLCanvasElement
  readonly controller: DomLinkController
  readonly layout: CommittedPointerLayout
  readonly root: HTMLDivElement
}

interface IntegratedHarness {
  readonly host: HTMLDivElement
  readonly renderer: FrameRenderer
  readonly terminal: Terminal
}

class FakeScrollbarClock implements TerminalScrollbarClock {
  private nextHandle = 1
  readonly timers = new Map<number, () => void>()

  clearTimeout(handle: number): void {
    this.timers.delete(handle)
  }

  setTimeout(callback: () => void): number {
    const handle = this.nextHandle
    this.nextHandle += 1
    this.timers.set(handle, callback)
    return handle
  }

  flush(): void {
    const entry = this.timers.entries().next().value as [number, () => void] | undefined
    if (!entry) throw new Error('No pending scrollbar timer')
    this.timers.delete(entry[0])
    entry[1]()
  }
}

class FrameRenderer implements GhosttyWebGpuRenderer {
  disposed = false
  emittedFrames = 0
  private font: TerminalFittedFont
  private grid: RendererGridSize
  readonly hasPendingFrame = false
  readonly hasPendingTimer = false

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onTextFrame: WebGpuTerminalRendererOptions['onTextFrame'],
    initial: Pick<WebGpuTerminalRendererOptions, 'columns' | 'font' | 'rows'>,
  ) {
    this.font = initial.font
    this.grid = { columns: initial.columns, rows: initial.rows }
    this.applyDimensions()
  }

  clearTextureAtlas(): void {}

  dispose(): void {
    this.disposed = true
  }

  emit(snapshot: RendererFrameSnapshot): void {
    this.emittedFrames += 1
    this.onTextFrame?.(snapshot)
  }

  notifyScroll(): void {}

  notifySelectionChange(): void {}

  notifyWrite(): void {}

  refreshRows(): void {}

  resize(grid: RendererGridSize): void {
    this.grid = grid
    this.applyDimensions()
  }

  private applyDimensions(): void {
    const cssWidth = this.font.cssCellWidth * this.grid.columns
    const cssHeight = this.font.cssCellHeight * this.grid.rows
    this.canvas.width = this.font.deviceCellWidth * this.grid.columns
    this.canvas.height = this.font.deviceCellHeight * this.grid.rows
    this.canvas.style.height = `${cssHeight}px`
    this.canvas.style.width = `${cssWidth}px`
  }

  schedule(): void {}

  setCursorBlinkEnabled(): void {}

  setDocumentVisible(): void {}

  setFocused(): void {}

  setFont(font: TerminalFittedFont): void {
    this.font = font
    this.applyDimensions()
  }

  setTheme(): void {}
}

let runtime: GhosttyRuntime

beforeAll(async () => {
  runtime = await GhosttyRuntime.create()
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

afterAll(() => {
  runtime.dispose()
})

function deferred<T>(): Deferred<T> {
  let rejectValue: (cause: unknown) => void = () => {}
  let resolveValue: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve, reject) => {
    rejectValue = reject
    resolveValue = resolve
  })
  return { promise, reject: rejectValue, resolve: resolveValue }
}

async function createSession<TEvent = Event>(
  options: TerminalSessionOptions<TEvent> = {},
): Promise<TerminalSession<TEvent>> {
  const session = await TerminalSession.create<TEvent>({
    ...options,
    runtime: { kind: 'borrowed', runtime },
  })
  cleanups.push(() => session.dispose())
  return session
}

function appendRoot(width: number, height: number): HTMLDivElement {
  const root = document.createElement('div')
  root.style.height = `${height}px`
  root.style.position = 'relative'
  root.style.width = `${width}px`
  document.body.append(root)
  cleanups.push(() => root.remove())
  return root
}

function frame(
  lines: readonly string[],
  cursor: { readonly wideTail?: boolean; readonly x?: number; readonly y?: number } = {},
): RendererFrameSnapshot {
  const rows = lines.map((text, y) =>
    Object.freeze({
      renderCells: Object.freeze(
        Array.from(text, (text, x) =>
          Object.freeze({ text, x, continuation: false, selected: false }),
        ),
      ),
      cells: Object.freeze(Array.from(text)),
      continuations: Object.freeze(Array.from(text, () => false)),
      text,
      y,
    }),
  )
  return Object.freeze({
    cursor: Object.freeze({
      blinking: false,
      passwordInput: false,
      style: 'block' as const,
      viewport: Object.freeze({
        wideTail: cursor.wideTail ?? false,
        x: cursor.x ?? 0,
        y: cursor.y ?? 0,
      }),
      visible: true,
    }),
    rows: Object.freeze(rows),
  })
}

function createLinkHarness(session: TerminalSession<Event>, lines: readonly string[]): LinkHarness {
  const columns = Math.max(...lines.map((line) => Array.from(line).length), 2)
  const rows = lines.length
  const cellWidth = 10
  const cellHeight = 20
  const root = appendRoot(columns * cellWidth, rows * cellHeight)
  const canvas = document.createElement('canvas')
  canvas.height = rows * cellHeight
  canvas.width = columns * cellWidth
  canvas.style.display = 'block'
  canvas.style.height = `${rows * cellHeight}px`
  canvas.style.width = `${columns * cellWidth}px`
  root.append(canvas)
  const layout: CommittedPointerLayout = Object.freeze({
    canvas,
    grid: Object.freeze({ cellHeight, cellWidth, columns, pixelRatio: 1, rows }),
    physical: Object.freeze({
      deviceCellHeight: cellHeight,
      deviceCellWidth: cellWidth,
      paddingBottom: 0,
      paddingLeft: 0,
      paddingRight: 0,
      paddingTop: 0,
      screenHeight: rows * cellHeight,
      screenWidth: columns * cellWidth,
    }),
  })
  const controller = createDomLinkController({
    canvas,
    getLayout: () => layout,
    root,
    session,
  })
  controller.updateFrame(frame(lines))
  cleanups.push(() => controller.dispose())
  return { canvas, controller, layout, root }
}

function cellPoint(
  layout: CommittedPointerLayout,
  column: number,
  row: number,
): { clientX: number; clientY: number } {
  const bounds = layout.canvas.getBoundingClientRect()
  return {
    clientX: bounds.left + (column + 0.5) * layout.grid.cellWidth,
    clientY: bounds.top + (row + 0.5) * layout.grid.cellHeight,
  }
}

function moveToCell(harness: LinkHarness, column: number, row: number): void {
  harness.canvas.dispatchEvent(
    new PointerEvent('pointermove', {
      bubbles: true,
      ...cellPoint(harness.layout, column, row),
    }),
  )
}

function clickCell(
  harness: LinkHarness,
  column: number,
  row: number,
  init: MouseEventInit = {},
): MouseEvent {
  const event = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    ...cellPoint(harness.layout, column, row),
    ...init,
  })
  harness.canvas.dispatchEvent(event)
  return event
}

function pointerClickCell(
  harness: LinkHarness,
  column: number,
  row: number,
  init: MouseEventInit = {},
): MouseEvent {
  const point = cellPoint(harness.layout, column, row)
  dispatchPointer(harness.canvas, 'pointerdown', point.clientX, point.clientY, init)
  dispatchPointer(harness.canvas, 'pointerup', point.clientX, point.clientY, init)
  return clickCell(harness, column, row, init)
}

function activationModifier(): MouseEventInit {
  if (/^(Mac|iPhone|iPad|iPod)/iu.test(navigator.platform)) return { metaKey: true }
  return { ctrlKey: true }
}

async function animationFrames(count = 1): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
}

async function settleTerminal(terminal: Terminal): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await animationFrames()
    if (!terminal.hasPendingFrame) return
  }
  throw new Error('Terminal frame did not settle')
}

async function waitForUi(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return
    await animationFrames()
  }
  throw new Error(message)
}

async function createIntegratedHarness(
  options: GhosttyWebGpuTerminalOptions = {},
): Promise<IntegratedHarness> {
  const host = appendRoot(420, 140)
  let renderer: FrameRenderer | undefined
  const terminal = await Terminal.create({
    ...options,
    appearance: {
      ...options.appearance,
      cursor: { blink: false, ...options.appearance?.cursor },
      grid: { columns: 30, rows: 4, ...options.appearance?.grid },
    },
    rendererFactory: async (rendererOptions) => {
      const canvas = rendererOptions.canvas
      if (!(canvas instanceof HTMLCanvasElement)) throw new TypeError('Expected an HTML canvas')
      renderer = new FrameRenderer(canvas, rendererOptions.onTextFrame, rendererOptions)
      return renderer
    },
    runtime: { kind: 'borrowed', runtime },
  })
  cleanups.push(() => terminal.dispose())
  await terminal.open(host)
  await settleTerminal(terminal)
  if (!renderer) throw new Error('Integrated renderer was not created')
  return { host, renderer, terminal }
}

async function createObservedRendererHarness(
  options: GhosttyWebGpuTerminalOptions = {},
  backend: 'webgpu' | 'webgl2' = 'webgpu',
  beforeCleanUpdate?: () => void,
  afterCleanUpdate?: () => void,
): Promise<{
  readonly host: HTMLDivElement
  readonly renderer: WebGpuTerminalRenderer | WebGlTerminalRenderer
  readonly snapshots: readonly RendererTextFrameSnapshot[]
  readonly terminal: Terminal
  readRowsCalls(): number
  readTextRowsCalls(): number
  updateCalls(): number
}> {
  const host = appendRoot(420, 140)
  const snapshots: RendererTextFrameSnapshot[] = []
  let renderer: WebGpuTerminalRenderer | WebGlTerminalRenderer | undefined
  let readRowsCalls = () => 0
  let readTextRowsCalls = () => 0
  let updateCalls = () => 0
  const terminal = await Terminal.create({
    ...options,
    accessibility: options.accessibility ?? false,
    appearance: {
      ...options.appearance,
      cursor: { blink: false, ...options.appearance?.cursor },
      grid: { columns: 30, rows: 4, ...options.appearance?.grid },
    },
    rendererFactory: async (rendererOptions) => {
      const readRows = vi.spyOn(rendererOptions.renderState, 'readRows')
      const readTextRows = vi.spyOn(rendererOptions.renderState, 'readTextRows')
      const update = vi.spyOn(rendererOptions.renderState, 'update')
      readRowsCalls = () => readRows.mock.calls.length
      readTextRowsCalls = () => readTextRows.mock.calls.length
      updateCalls = () => update.mock.calls.length
      cleanups.push(() => {
        readRows.mockRestore()
        readTextRows.mockRestore()
        update.mockRestore()
      })
      const observedOptions: WebGpuTerminalRendererOptions = {
        ...rendererOptions,
        onCleanUpdate: () => {
          beforeCleanUpdate?.()
          rendererOptions.onCleanUpdate?.()
          afterCleanUpdate?.()
        },
        onTextFrame: (snapshot) => {
          snapshots.push(snapshot)
          rendererOptions.onTextFrame?.(snapshot)
        },
      }
      renderer =
        backend === 'webgl2'
          ? await WebGlTerminalRenderer.create(observedOptions)
          : await WebGpuTerminalRenderer.create(observedOptions)
      return renderer
    },
    runtime: { kind: 'borrowed', runtime },
  })
  cleanups.push(() => terminal.dispose())
  const font = fitTerminalFont(document, terminal.appearance.font, window.devicePixelRatio)
  const grid = terminal.appearance.grid
  host.style.width = `${Math.ceil(font.cssCellWidth * grid.columns + 12)}px`
  host.style.height = `${Math.ceil(font.cssCellHeight * grid.rows)}px`
  await terminal.open(host)
  await settleTerminal(terminal)
  if (!renderer) throw new Error('Observed renderer was not created')
  return { host, renderer, snapshots, terminal, readRowsCalls, readTextRowsCalls, updateCalls }
}

function measuredFrame(lines: readonly string[]): {
  readonly reads: Record<
    'cells' | 'continuations' | 'cursor' | 'renderCells' | 'text' | 'y',
    number
  >
  readonly snapshot: RendererFrameSnapshot
} {
  const source = frame(lines)
  const reads = { cells: 0, continuations: 0, cursor: 0, renderCells: 0, text: 0, y: 0 }
  const rows = source.rows.map((row) =>
    Object.freeze({
      get cells() {
        reads.cells += 1
        return row.cells
      },
      get continuations() {
        reads.continuations += 1
        return row.continuations
      },
      get renderCells() {
        reads.renderCells += 1
        return row.renderCells
      },
      get text() {
        reads.text += 1
        return row.text
      },
      get y() {
        reads.y += 1
        return row.y
      },
    }),
  )
  const snapshot = Object.freeze({
    get cursor() {
      reads.cursor += 1
      return source.cursor
    },
    rows: Object.freeze(rows),
  })
  return { reads, snapshot }
}

function terminalCellPoint(
  terminal: Terminal,
  column: number,
  row: number,
): { readonly clientX: number; readonly clientY: number } {
  const canvas = terminal.canvas
  if (!canvas) throw new Error('Terminal canvas is not open')
  const bounds = canvas.getBoundingClientRect()
  const grid = terminal.appearance.grid
  return {
    clientX: bounds.left + (column + 0.5) * grid.cellWidth,
    clientY: bounds.top + (row + 0.5) * grid.cellHeight,
  }
}

function moveTerminalPointer(terminal: Terminal, column: number, row: number): void {
  const canvas = terminal.canvas
  if (!canvas) throw new Error('Terminal canvas is not open')
  canvas.dispatchEvent(
    new PointerEvent('pointermove', {
      bubbles: true,
      ...terminalCellPoint(terminal, column, row),
    }),
  )
}

function dispatchModifiedTerminalClick(
  terminal: Terminal,
  column: number,
  row: number,
): MouseEvent {
  const canvas = terminal.canvas
  if (!canvas) throw new Error('Terminal canvas is not open')
  const point = terminalCellPoint(terminal, column, row)
  const modifier = activationModifier()
  dispatchPointer(canvas, 'pointerdown', point.clientX, point.clientY, modifier)
  dispatchPointer(canvas, 'pointerup', point.clientX, point.clientY, modifier)
  const click = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    ...point,
    ...modifier,
  })
  canvas.dispatchEvent(click)
  return click
}

async function settleLink(controller: DomLinkController): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await Promise.resolve()
    if (!controller.hasPendingResolution) return
  }
  throw new Error('Link resolution did not settle')
}

function installPointerCapture(element: HTMLElement): Set<number> {
  const captured = new Set<number>()
  Object.defineProperties(element, {
    hasPointerCapture: {
      configurable: true,
      value: (pointerId: number) => captured.has(pointerId),
    },
    releasePointerCapture: {
      configurable: true,
      value: (pointerId: number) => captured.delete(pointerId),
    },
    setPointerCapture: {
      configurable: true,
      value: (pointerId: number) => captured.add(pointerId),
    },
  })
  return captured
}

function dispatchPointer(
  target: HTMLElement,
  type: string,
  clientX: number,
  clientY: number,
  init: PointerEventInit = {},
): PointerEvent {
  const event = new PointerEvent(type, {
    bubbles: true,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    cancelable: true,
    clientX,
    clientY,
    pointerId: 7,
    ...init,
  })
  target.dispatchEvent(event)
  return event
}

function dispatchKey(target: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key })
  target.dispatchEvent(event)
  return event
}

function scrollbarActions(): {
  readonly calls: string[]
  readonly controller: Parameters<typeof createTerminalScrollbar>[0]['actions']
} {
  const calls: string[] = []
  return {
    calls,
    controller: {
      scrollBy: (delta) => calls.push(`by:${delta}`),
      scrollToBottom: () => calls.push('bottom'),
      scrollToRow: (row) => calls.push(`row:${row}`),
      scrollToTop: () => calls.push('top'),
    },
  }
}

function createAccessibilityHarness(options?: {
  readonly liveRegionMaxCharacters?: number
  readonly liveRegionMaxEntries?: number
}): {
  readonly controller: TerminalAccessibilityController
  readonly root: HTMLDivElement
  readonly textarea: HTMLTextAreaElement
} {
  const root = appendRoot(320, 120)
  const textarea = document.createElement('textarea')
  textarea.setAttribute('aria-label', 'Existing terminal label')
  root.append(textarea)
  const controller = createTerminalAccessibility({ root, textarea, ...options })
  cleanups.push(() => controller.dispose())
  return { controller, root, textarea }
}

function scrollbar(offset: number, total: number, length = 2): Readonly<TerminalScrollbar> {
  return Object.freeze({ length, offset, total })
}

describe('terminal links in Chromium', () => {
  it('keeps native OSC 8 ahead of providers and regex, and activates only by explicit callback', async () => {
    const activated: Array<{ event: Event; uri: string }> = []
    let providerCalls = 0
    const session = await createSession<Event>({
      appearance: { grid: { columns: 40, rows: 2 } },
      links: {
        activateUri: (uri, event) => {
          activated.push({ event, uri })
        },
      },
    })
    session.registerLinkProvider({
      provideLinks: () => {
        providerCalls += 1
        return [{ activate: () => {}, range: { end: 17, start: 0 }, text: 'provider' }]
      },
    })
    const text = 'https://regex.test'
    session.write(`${escape}]8;;https://osc8.test\u0007${text}${escape}]8;;\u0007`)
    const harness = createLinkHarness(session, [text, ''])

    moveToCell(harness, 5, 0)
    await settleLink(harness.controller)

    expect(harness.controller.currentHit).toMatchObject({
      range: { end: text.length - 1, start: 0 },
      source: 'osc8',
      uri: 'https://osc8.test',
    })
    expect(providerCalls).toBe(0)
    expect(harness.canvas.style.cursor).toBe('pointer')
    expect(harness.root.querySelector<HTMLElement>('[role="link"]')?.style.width).toBe(
      `${text.length * harness.layout.grid.cellWidth}px`,
    )

    const plain = clickCell(harness, 5, 0)
    await Promise.resolve()
    expect(plain.defaultPrevented).toBe(false)
    expect(activated).toEqual([])

    installPointerCapture(harness.canvas)
    const modified = pointerClickCell(harness, 5, 0, activationModifier())
    await Promise.resolve()
    expect(modified.defaultPrevented).toBe(true)
    expect(activated).toHaveLength(1)
    expect(activated[0]!.uri).toBe('https://osc8.test')
    expect(activated[0]!.event).toBe(modified)
  })

  it('discovers each contiguous OSC 8 hyperlink once', async () => {
    const session = await createSession<Event>({
      appearance: { grid: { columns: 20, rows: 1 } },
    })
    session.write(
      `${escape}]8;;https://first.test\u0007one${escape}]8;;\u0007 ${escape}]8;;https://second.test\u0007two${escape}]8;;\u0007`,
    )
    const harness = createLinkHarness(session, ['one two'])

    await expect(harness.controller.focusNextLink()).resolves.toBe(true)
    expect(harness.controller.currentHit).toMatchObject({
      range: { end: 2, start: 0 },
      uri: 'https://first.test',
    })

    await expect(harness.controller.focusNextLink()).resolves.toBe(true)
    expect(harness.controller.currentHit).toMatchObject({
      range: { end: 6, start: 4 },
      uri: 'https://second.test',
    })
  })

  it('drops stale async provider hits after the pointer moves to another row', async () => {
    const old = deferred<readonly ProvidedLink<Event>[] | undefined>()
    const session = await createSession<Event>({
      appearance: { grid: { columns: 12, rows: 2 } },
    })
    session.write('old\r\nnew')
    session.registerLinkProvider({
      provideLinks: (_line, row) => {
        if (row === 0) return old.promise
        return [{ activate: () => {}, range: { end: 2, start: 0 }, text: 'new' }]
      },
    })
    const harness = createLinkHarness(session, ['old', 'new'])

    moveToCell(harness, 1, 0)
    expect(harness.controller.hasPendingResolution).toBe(true)
    moveToCell(harness, 1, 1)
    await settleLink(harness.controller)
    expect(harness.controller.currentHit).toMatchObject({ row: 1, text: 'new' })

    old.resolve([{ activate: () => {}, range: { end: 2, start: 0 }, text: 'old' }])
    await Promise.resolve()
    await Promise.resolve()

    expect(harness.controller.currentHit).toMatchObject({ row: 1, text: 'new' })
    expect(harness.root.querySelector('[role="link"]')?.getAttribute('aria-label')).toBe('new')
  })

  it('clears pending link state when provider registration invalidates an awaiting result', async () => {
    const pending = deferred<readonly ProvidedLink<Event>[] | undefined>()
    const session = await createSession<Event>({
      appearance: { grid: { columns: 12, rows: 1 } },
    })
    session.write('pending')
    session.registerLinkProvider({ provideLinks: () => pending.promise })
    const harness = createLinkHarness(session, ['pending'])

    moveToCell(harness, 1, 0)
    expect(harness.controller.hasPendingResolution).toBe(true)
    session.registerLinkProvider({ provideLinks: () => undefined })
    pending.resolve([{ activate: () => {}, range: { end: 6, start: 0 } }])
    await settleLink(harness.controller)

    expect(harness.controller.currentHit).toBeUndefined()
    expect(harness.controller.hasPendingResolution).toBe(false)

    harness.controller.dispose()
    expect(harness.controller.hasPendingResolution).toBe(false)
    expect(harness.root.querySelector('.ghostty-webgpu-link')).toBeNull()
    expect(harness.canvas.style.cursor).toBe('')
  })

  it('does not navigate built-in URLs without an activation callback', async () => {
    const session = await createSession<Event>({
      appearance: { grid: { columns: 40, rows: 1 } },
    })
    const text = 'https://no-navigation.test'
    session.write(text)
    const harness = createLinkHarness(session, [text])
    const before = window.location.href

    moveToCell(harness, 5, 0)
    await settleLink(harness.controller)
    expect(harness.controller.currentHit).toMatchObject({ source: 'url', uri: text })

    installPointerCapture(harness.canvas)
    const click = pointerClickCell(harness, 5, 0, activationModifier())
    await Promise.resolve()
    expect(click.defaultPrevented).toBe(true)
    expect(window.location.href).toBe(before)
  })

  it('rolls back modifier ownership when pointer capture fails', async () => {
    const activations: string[] = []
    const session = await createSession<Event>({
      links: { activateUri: (uri) => void activations.push(uri) },
    })
    const text = 'https://capture-failure.test'
    const harness = createLinkHarness(session, [text])
    moveToCell(harness, 5, 0)
    await settleLink(harness.controller)
    Object.defineProperty(harness.canvas, 'setPointerCapture', {
      configurable: true,
      value: () => {
        throw new TypeError('capture failed')
      },
    })
    let routedPointerDown = false
    harness.canvas.addEventListener('pointerdown', () => {
      routedPointerDown = true
    })
    const point = cellPoint(harness.layout, 5, 0)

    const down = dispatchPointer(
      harness.canvas,
      'pointerdown',
      point.clientX,
      point.clientY,
      activationModifier(),
    )
    dispatchPointer(harness.canvas, 'pointerup', point.clientX, point.clientY, activationModifier())
    const click = clickCell(harness, 5, 0, activationModifier())

    expect(down.defaultPrevented).toBe(false)
    expect(click.defaultPrevented).toBe(false)
    expect(routedPointerDown).toBe(true)
    expect(activations).toEqual([])
  })

  it('cancels a claimed modifier gesture on owning-window blur', async () => {
    const activations: string[] = []
    const session = await createSession<Event>({
      links: { activateUri: (uri) => void activations.push(uri) },
    })
    const text = 'https://blur-capture.test'
    const harness = createLinkHarness(session, [text])
    moveToCell(harness, 5, 0)
    await settleLink(harness.controller)
    const captured = installPointerCapture(harness.canvas)
    const point = cellPoint(harness.layout, 5, 0)
    const down = dispatchPointer(
      harness.canvas,
      'pointerdown',
      point.clientX,
      point.clientY,
      activationModifier(),
    )
    expect(down.defaultPrevented).toBe(true)
    expect(captured.has(7)).toBe(true)

    window.dispatchEvent(new Event('blur'))
    dispatchPointer(harness.canvas, 'pointerup', point.clientX, point.clientY, activationModifier())
    clickCell(harness, 5, 0, activationModifier())
    harness.canvas.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }))

    expect(captured.size).toBe(0)
    expect(activations).toEqual([])
    expect(harness.controller.currentHit).toBeUndefined()
  })
})

describe('terminal scrollbar in Chromium', () => {
  it('renders changed snapshots and width without reading client geometry', () => {
    const root = appendRoot(48, 200)
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    cleanups.push(() => rect.mockRestore())
    const controller = createTerminalScrollbar({
      actions: scrollbarActions().controller,
      root,
      snapshot: scrollbar(20, 100, 20),
    })
    cleanups.push(() => controller.dispose())
    expect(controller.update(scrollbar(40, 100, 20))).toBe(true)
    expect(controller.setWidth(16)).toBe(true)
    const reads = rect.mock.contexts.filter(
      (element) => element === controller.element || element === controller.thumb,
    )
    expect(reads).toHaveLength(0)
    expect(controller.element.getAttribute('aria-valuenow')).toBe('40')
  })

  it('leaves equal snapshots entirely unchanged', () => {
    const root = appendRoot(48, 200)
    const controller = createTerminalScrollbar({
      actions: scrollbarActions().controller,
      root,
      snapshot: scrollbar(20, 100, 20),
    })
    cleanups.push(() => controller.dispose())
    const observer = new MutationObserver(() => {})
    observer.observe(controller.element, { attributes: true, childList: true, subtree: true })
    cleanups.push(() => observer.disconnect())
    const rect = vi.spyOn(controller.element, 'getBoundingClientRect')
    cleanups.push(() => rect.mockRestore())
    expect(controller.update(scrollbar(20, 100, 20))).toBe(false)
    expect(observer.takeRecords()).toHaveLength(0)
    expect(rect).not.toHaveBeenCalled()
  })

  it.each([
    { offset: 0, total: 0, length: 0 },
    { offset: 0, total: 100, length: 20 },
    { offset: 40, total: 100, length: 20 },
    { offset: 80, total: 100, length: 20 },
    { offset: 495, total: 1000, length: 10 },
    { offset: 0, total: 20, length: 20 },
    { offset: 0x1_0000_0000, total: 0x2_0000_0000, length: 20 },
  ])(
    'tracks resize, sub-row resize, hidden roots, minimum and cap for $offset/$total',
    (snapshot) => {
      const root = appendRoot(48, 200)
      const controller = createTerminalScrollbar({
        actions: scrollbarActions().controller,
        root,
        snapshot,
      })
      cleanups.push(() => controller.dispose())
      const maximum = snapshot.total - snapshot.length
      const progress = maximum === 0 ? 0 : snapshot.offset / maximum
      const ratio = snapshot.total === 0 ? 1 : snapshot.length / snapshot.total
      for (const height of [200, 199, 100, 40, 10, 200]) {
        root.style.height = `${height}px`
        const track = controller.element.getBoundingClientRect()
        const thumb = controller.thumb.getBoundingClientRect()
        const expectedHeight = Math.min(height, Math.max(20, height * ratio))
        expect(thumb.height).toBeCloseTo(expectedHeight, 1)
        expect(thumb.top - track.top).toBeCloseTo(progress * (height - expectedHeight), 1)
        expect(controller.update(snapshot)).toBe(false)
      }
      root.style.display = 'none'
      expect(controller.update(snapshot)).toBe(false)
      expect(controller.thumb.getBoundingClientRect().height).toBe(0)
      root.style.height = '123px'
      root.style.display = ''
      const track = controller.element.getBoundingClientRect()
      const thumb = controller.thumb.getBoundingClientRect()
      const expectedHeight = Math.min(123, Math.max(20, 123 * ratio))
      expect(thumb.height).toBeCloseTo(expectedHeight, 1)
      expect(thumb.top - track.top).toBeCloseTo(progress * (123 - expectedHeight), 1)
      expect(controller.element.getAttribute('aria-valuemax')).toBe(String(maximum))
      expect(controller.element.getAttribute('aria-valuenow')).toBe(String(snapshot.offset))
    },
  )

  it.each([0.5, 2])(
    'uses rendered client units for translated/scaled hit, page and drag at %s',
    (scale) => {
      const root = appendRoot(48, 200)
      root.style.transformOrigin = 'top left'
      root.style.transform = `translate(37px, 11px) scale(${scale})`
      const actions = scrollbarActions()
      const controller = createTerminalScrollbar({
        actions: actions.controller,
        clock: new FakeScrollbarClock(),
        root,
        snapshot: scrollbar(240, 1000, 10),
      })
      cleanups.push(() => controller.dispose())
      const captured = installPointerCapture(controller.element)
      const track = controller.element.getBoundingClientRect()
      const thumb = controller.thumb.getBoundingClientRect()
      const x = track.left + track.width / 2
      const y = thumb.top + thumb.height / 2
      expect(controller.hitTest({ clientX: x, clientY: y, target: root })).toBe(true)
      expect(controller.hitTest({ clientX: track.right + 1, clientY: y, target: root })).toBe(false)
      dispatchPointer(controller.element, 'pointerdown', x, thumb.top - 1)
      expect(actions.calls.pop()).toBe('by:-10')
      dispatchPointer(controller.element, 'pointerdown', x, thumb.bottom + 1)
      expect(actions.calls.pop()).toBe('by:10')
      dispatchPointer(controller.element, 'pointerdown', x, y)
      expect(captured.has(7)).toBe(true)
      dispatchPointer(controller.element, 'pointermove', x, y)
      expect(actions.calls.pop()).toBe('row:240')
      dispatchPointer(controller.element, 'pointermove', x, y + (track.height - thumb.height) / 4)
      expect(actions.calls.pop()).toBe('row:488')
      dispatchPointer(controller.element, 'pointermove', x, track.top - thumb.height)
      expect(actions.calls.pop()).toBe('row:0')
      dispatchPointer(controller.element, 'pointermove', x, track.bottom + thumb.height)
      expect(actions.calls.pop()).toBe('row:990')
      dispatchPointer(controller.element, 'pointerup', x, y)
      expect(captured.size).toBe(0)
      for (const [deltaMode, deltaY, rows] of [
        [WheelEvent.DOM_DELTA_LINE, 3, 3],
        [WheelEvent.DOM_DELTA_PAGE, 2, 20],
        [WheelEvent.DOM_DELTA_PIXEL, track.height / 10, 1],
      ]) {
        controller.element.dispatchEvent(
          new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaMode, deltaY }),
        )
        expect(actions.calls.pop()).toBe(`by:${rows}`)
      }
    },
  )

  it('keeps actual terminal geometry aligned through font, grid and parent-height changes', async () => {
    const { host, terminal } = await createObservedRendererHarness({}, 'webgl2')
    terminal.write(Array.from({ length: 100 }, (_, index) => `row ${index}\r\n`).join(''))
    await settleTerminal(terminal)
    const element = host.querySelector<HTMLDivElement>('[role="scrollbar"]')!
    const thumb = element.firstElementChild as HTMLDivElement
    for (const size of [14, 20, 12]) {
      terminal.setFont({ size })
      await animationFrames()
      await settleTerminal(terminal)
      const { cellHeight } = terminal.appearance.grid
      // Keep both parent heights inside the fitted row interval across platform font metrics.
      const height = Math.ceil(cellHeight * 8.5)
      expect(height + 1).toBeLessThan(cellHeight * 9)
      host.style.height = `${height}px`
      await animationFrames()
      await settleTerminal(terminal)
      const { rows } = terminal.appearance.grid
      expect(rows).toBe(8)
      const maximum = Number(element.getAttribute('aria-valuemax'))
      expect(maximum).toBeGreaterThan(0)
      expect(element.getAttribute('aria-valuenow')).toBe(String(maximum))
      const track = element.getBoundingClientRect()
      const geometry = thumb.getBoundingClientRect()
      const expectedHeight = Math.min(
        track.height,
        Math.max(20, (track.height * rows) / (maximum + rows)),
      )
      expect(geometry.height).toBeCloseTo(expectedHeight, 1)
      expect(geometry.bottom).toBeCloseTo(track.bottom, 1)
      const previousRows = rows
      host.style.height = `${height + 1}px`
      await animationFrames()
      await settleTerminal(terminal)
      expect(terminal.appearance.grid.rows).toBe(previousRows)
      expect(thumb.getBoundingClientRect().bottom).toBeCloseTo(
        element.getBoundingClientRect().bottom,
        1,
      )
      terminal.scrollToTop()
      await settleTerminal(terminal)
      expect(element.getAttribute('aria-valuenow')).toBe('0')
      expect(thumb.getBoundingClientRect().top).toBeCloseTo(element.getBoundingClientRect().top, 1)
      terminal.scrollToBottom()
      await settleTerminal(terminal)
    }
    element.focus()
    await page.screenshot({
      element: terminal.element!,
      path: '../../../.artifacts/scrollbar-font-grid.png',
      scale: 'css',
    })
    terminal.dispose()
    expect(element.isConnected).toBe(false)
    expect(terminal.hasPendingTimer).toBe(false)
  })

  it('releases a scaled drag and its fade timer when aborted, then ignores input and updates', () => {
    const root = appendRoot(48, 200)
    root.style.transform = 'scale(0.5)'
    const abort = new AbortController()
    const clock = new FakeScrollbarClock()
    const actions = scrollbarActions()
    const controller = createTerminalScrollbar({
      actions: actions.controller,
      clock,
      root,
      signal: abort.signal,
      snapshot: scrollbar(20, 100, 20),
    })
    cleanups.push(() => controller.dispose())
    const captured = installPointerCapture(controller.element)
    const thumb = controller.thumb.getBoundingClientRect()
    dispatchPointer(controller.element, 'pointerdown', thumb.left, thumb.top + thumb.height / 2)
    expect(captured.has(7)).toBe(true)
    abort.abort()
    expect(captured.size).toBe(0)
    expect(clock.timers.size).toBe(0)
    expect(controller.element.isConnected).toBe(false)
    expect(controller.update(scrollbar(40, 100, 20))).toBe(false)
    expect(controller.setWidth(16)).toBe(false)
    dispatchKey(controller.element, 'ArrowDown')
    dispatchPointer(controller.element, 'pointermove', thumb.left, thumb.bottom)
    expect(actions.calls).toEqual([])
  })

  it('supports exact large ARIA values, keyboard, paging, dragging, wheel, and one fade timer', () => {
    const root = appendRoot(48, 200)
    const clock = new FakeScrollbarClock()
    const actions = scrollbarActions()
    const big = 0x1_0000_0000
    const snapshot = scrollbar(big + 2, big * 2 + 1_000, 20)
    const errors: Array<{ cause: unknown; operation: string }> = []
    const controller = createTerminalScrollbar({
      actions: actions.controller,
      clock,
      onError: (cause, operation) => errors.push({ cause, operation }),
      root,
      snapshot,
    })
    const captured = installPointerCapture(controller.element)
    cleanups.push(() => controller.dispose())

    expect(controller.element.getAttribute('role')).toBe('scrollbar')
    expect(controller.element.getAttribute('aria-orientation')).toBe('vertical')
    expect(controller.element.getAttribute('aria-valuemin')).toBe('0')
    expect(controller.element.getAttribute('aria-valuenow')).toBe(String(big + 2))
    expect(controller.element.getAttribute('aria-valuemax')).toBe(String(big * 2 + 980))
    expect(controller.visible).toBe(false)
    expect(controller.hasPendingTimer).toBe(false)

    for (const key of ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']) {
      expect(dispatchKey(controller.element, key).defaultPrevented).toBe(true)
    }
    expect(actions.calls.slice(0, 6)).toEqual(['by:-1', 'by:1', 'by:-20', 'by:20', 'top', 'bottom'])
    expect(clock.timers.size).toBe(1)

    const bounds = controller.element.getBoundingClientRect()
    dispatchPointer(controller.element, 'pointerdown', bounds.left + 2, bounds.bottom - 2)
    expect(actions.calls).toContain('by:20')

    const thumb = controller.thumb.getBoundingClientRect()
    const thumbY = thumb.top + thumb.height / 2
    dispatchPointer(controller.element, 'pointerdown', bounds.left + 2, thumbY)
    expect(captured.has(7)).toBe(true)
    dispatchPointer(controller.element, 'pointermove', bounds.left + 2, bounds.bottom - 30)
    const absoluteCall = actions.calls.find((call) => call.startsWith('row:'))
    expect(Number(absoluteCall?.slice(4))).toBeGreaterThan(big)
    dispatchPointer(controller.element, 'pointerup', bounds.left + 2, bounds.bottom - 30)
    expect(captured.size).toBe(0)

    const wheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      deltaY: 3,
    })
    controller.element.dispatchEvent(wheel)
    expect(wheel.defaultPrevented).toBe(true)
    expect(actions.calls).toContain('by:3')

    controller.notifyActivity()
    controller.notifyActivity()
    expect(controller.visible).toBe(true)
    expect(controller.hasPendingTimer).toBe(true)
    expect(clock.timers.size).toBe(1)
    expect(errors).toEqual([])

    clock.flush()
    expect(controller.visible).toBe(false)
    expect(controller.hasPendingTimer).toBe(false)
    expect(clock.timers.size).toBe(0)

    controller.notifyActivity()
    controller.dispose()
    expect(clock.timers.size).toBe(0)
    expect(controller.element.isConnected).toBe(false)
  })

  it('routes action failures and cancels a lost-capture drag without throwing', () => {
    const root = appendRoot(48, 200)
    const failure = new Error('scroll failed')
    const errors: Array<{ cause: unknown; operation: string }> = []
    const controller = createTerminalScrollbar({
      actions: {
        scrollBy: () => {
          throw failure
        },
        scrollToBottom: () => {},
        scrollToRow: () => {},
        scrollToTop: () => {},
      },
      onError: (cause, operation) => errors.push({ cause, operation }),
      root,
      snapshot: scrollbar(20, 100, 20),
    })
    const captured = installPointerCapture(controller.element)
    cleanups.push(() => controller.dispose())

    expect(() => dispatchKey(controller.element, 'ArrowDown')).not.toThrow()
    expect(errors).toEqual([{ cause: failure, operation: 'keyboard.arrow-down' }])

    const thumb = controller.thumb.getBoundingClientRect()
    dispatchPointer(controller.element, 'pointerdown', thumb.left, thumb.top + thumb.height / 2)
    expect(captured.has(7)).toBe(true)
    captured.delete(7)
    controller.element.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 7 }))
    const move = dispatchPointer(controller.element, 'pointermove', thumb.left, thumb.bottom)
    expect(move.defaultPrevented).toBe(false)
  })

  it('ends an active drag when the owning window blurs', () => {
    const root = appendRoot(48, 200)
    const clock = new FakeScrollbarClock()
    const controller = createTerminalScrollbar({
      actions: scrollbarActions().controller,
      clock,
      root,
      snapshot: scrollbar(20, 100, 20),
    })
    const captured = installPointerCapture(controller.element)
    cleanups.push(() => controller.dispose())

    const thumb = controller.thumb.getBoundingClientRect()
    dispatchPointer(controller.element, 'pointerdown', thumb.left, thumb.top + thumb.height / 2)
    expect(captured.has(7)).toBe(true)
    expect(controller.visible).toBe(true)
    expect(controller.hasPendingTimer).toBe(false)

    window.dispatchEvent(new Event('blur'))

    expect(captured.size).toBe(0)
    expect(controller.visible).toBe(false)
    expect(controller.hasPendingTimer).toBe(false)
    const move = dispatchPointer(controller.element, 'pointermove', thumb.left, thumb.bottom)
    expect(move.defaultPrevented).toBe(false)
  })

  it('rolls back a drag when pointer capture throws', () => {
    const root = appendRoot(48, 200)
    const clock = new FakeScrollbarClock()
    const failure = new TypeError('capture failed')
    const errors: Array<{ cause: unknown; operation: string }> = []
    const controller = createTerminalScrollbar({
      actions: scrollbarActions().controller,
      clock,
      onError: (cause, operation) => errors.push({ cause, operation }),
      root,
      snapshot: scrollbar(20, 100, 20),
    })
    Object.defineProperty(controller.element, 'setPointerCapture', {
      configurable: true,
      value: () => {
        throw failure
      },
    })
    cleanups.push(() => controller.dispose())

    const thumb = controller.thumb.getBoundingClientRect()
    const down = dispatchPointer(
      controller.element,
      'pointerdown',
      thumb.left,
      thumb.top + thumb.height / 2,
    )

    expect(down.defaultPrevented).toBe(true)
    expect(errors).toEqual([{ cause: failure, operation: 'pointer.capture' }])
    expect(controller.hasPendingTimer).toBe(true)
    const move = dispatchPointer(controller.element, 'pointermove', thumb.left, thumb.bottom)
    expect(move.defaultPrevented).toBe(false)
  })

  it('rolls back invalid construction and fades after a failed thumb drag', () => {
    const root = appendRoot(48, 200)
    const clock = new FakeScrollbarClock()
    const failure = new Error('drag failed')
    const errors: Array<{ cause: unknown; operation: string }> = []

    expect(() =>
      createTerminalScrollbar({
        actions: scrollbarActions().controller,
        root,
        snapshot: scrollbar(0, 1, 2),
      }),
    ).toThrow('scrollbar length must not exceed total')
    expect(root.querySelector('.ghostty-webgpu-scrollbar')).toBeNull()

    const controller = createTerminalScrollbar({
      actions: {
        scrollBy: () => {},
        scrollToBottom: () => {},
        scrollToRow: () => {
          throw failure
        },
        scrollToTop: () => {},
      },
      clock,
      onError: (cause, operation) => errors.push({ cause, operation }),
      root,
      snapshot: scrollbar(20, 100, 20),
    })
    const captured = installPointerCapture(controller.element)
    cleanups.push(() => controller.dispose())

    const thumb = controller.thumb.getBoundingClientRect()
    dispatchPointer(controller.element, 'pointerdown', thumb.left, thumb.top + thumb.height / 2)
    expect(captured.has(7)).toBe(true)
    expect(controller.hasPendingTimer).toBe(false)

    dispatchPointer(controller.element, 'pointermove', thumb.left, thumb.bottom)
    expect(errors).toEqual([{ cause: failure, operation: 'pointer.drag' }])
    expect(captured.size).toBe(0)
    expect(controller.visible).toBe(true)
    expect(controller.hasPendingTimer).toBe(true)

    clock.flush()
    expect(controller.visible).toBe(false)
    expect(controller.hasPendingTimer).toBe(false)
  })
})

describe('terminal accessibility mirror in Chromium', () => {
  it('keeps stable visible rows, exposes the cursor, and bounds live output without replaying history', () => {
    const harness = createAccessibilityHarness({
      liveRegionMaxCharacters: 8,
      liveRegionMaxEntries: 2,
    })
    const current = scrollbar(2, 4)
    const first = harness.controller.update(frame(['alpha', 'beta'], { x: 3, y: 1 }), current)
    const initialRows = [...harness.controller.rowElements]
    const initialIds = initialRows.map((row) => row.id)

    expect(first).toEqual({ announced: false, full: true, updatedRows: 2 })
    expect(initialRows.map((row) => row.getAttribute('role'))).toEqual(['listitem', 'listitem'])
    expect(initialRows.map((row) => row.getAttribute('aria-posinset'))).toEqual(['3', '4'])
    expect(initialRows.map((row) => row.getAttribute('aria-setsize'))).toEqual(['4', '4'])
    expect(harness.controller.cursorStatus.textContent).toBe('Cursor at row 4, column 4')
    expect(harness.textarea.getAttribute('aria-activedescendant')).toBe(initialRows[1]!.id)
    expect(harness.controller.mirror.style.display).toBe('')
    expect(harness.controller.mirror.style.visibility).toBe('')
    expect(harness.controller.mirror.getAttribute('aria-hidden')).toBeNull()

    harness.controller.notifyOutput()
    const second = harness.controller.update(frame(['alpha', 'betaA'], { x: 3, y: 1 }), current)
    expect(second).toEqual({ announced: true, full: false, updatedRows: 1 })
    expect(harness.controller.rowElements.map((row) => row.id)).toEqual(initialIds)

    harness.controller.notifyOutput()
    harness.controller.update(frame(['alpha', 'betaAB'], { x: 3, y: 1 }), current)
    harness.controller.notifyOutput()
    harness.controller.update(frame(['alpha', 'betaABC'], { x: 3, y: 1 }), current)
    expect(harness.controller.liveRegion.children).toHaveLength(2)
    expect(harness.controller.liveRegion.textContent).toBe('BC')

    harness.controller.notifyOutput()
    const history = harness.controller.update(
      frame(['old-a', 'old-b'], { x: 0, y: 0 }),
      scrollbar(0, 4),
    )
    expect(history.full).toBe(true)
    expect(history.announced).toBe(false)
    expect(harness.controller.liveRegion.textContent).toBe('BC')

    harness.controller.dispose()
    expect(harness.root.querySelector('.ghostty-webgpu-accessibility')).toBeNull()
    expect(harness.root.querySelector('.ghostty-webgpu-live-region')).toBeNull()
    expect(harness.textarea.getAttribute('aria-label')).toBe('Existing terminal label')
    expect(harness.textarea.hasAttribute('aria-controls')).toBe(false)
  })

  it('maps a wide-tail cursor to the leading cell and clips one oversized announcement', () => {
    const harness = createAccessibilityHarness({
      liveRegionMaxCharacters: 5,
      liveRegionMaxEntries: 3,
    })
    const current = scrollbar(0, 1, 1)
    harness.controller.update(frame(['start'], { wideTail: true, x: 4, y: 0 }), current)
    harness.controller.notifyOutput()
    harness.controller.update(frame(['start0123456789'], { wideTail: true, x: 4, y: 0 }), current)

    expect(harness.controller.cursorStatus.textContent).toBe('Cursor at row 1, column 4')
    expect(harness.controller.liveRegion.textContent).toBe('56789')
  })
})

describe('terminal clipboard policy in Chromium', () => {
  it('default-denies OSC 52 and separates opt-in acceptance from asynchronous completion', async () => {
    const defaultErrors: unknown[] = []
    expect(createDomClipboardPolicyAdapter({ onError: (cause) => defaultErrors.push(cause) })).toBe(
      undefined,
    )
    const denied = await createSession()
    denied.on('error', (error) => defaultErrors.push(error))
    denied.write(`${escape}]52;c;ZGVuaWVk\u0007`)
    expect(defaultErrors).toEqual([])

    const completion = deferred<void>()
    const completionFailure = new Error('browser clipboard failed')
    const completionErrors: Array<{ cause: unknown; operation: string }> = []
    const writes: string[] = []
    const syncResults: string[] = []
    const adapter = createDomClipboardPolicyAdapter({
      onError: (cause, operation) => completionErrors.push({ cause, operation }),
      policy: (write) => {
        writes.push(decoder.decode(write.contents[0]!.data))
        return { completion: completion.promise, result: 'success' }
      },
    })
    if (!adapter) throw new Error('Expected an opt-in clipboard adapter')
    const optedIn = await createSession({
      clipboardWrite: (write) => {
        const result = adapter(write)
        syncResults.push(result)
        return result
      },
    })

    optedIn.write(`${escape}]52;c;Y29waWVk\u0007`)
    expect(writes).toEqual(['copied'])
    expect(syncResults).toEqual(['success'])
    expect(completionErrors).toEqual([])

    completion.reject(completionFailure)
    await Promise.resolve()
    await Promise.resolve()
    expect(completionErrors).toEqual([
      { cause: completionFailure, operation: 'clipboardWrite.completion' },
    ])
  })
})

describe('terminal frame consumer demand in Chromium', () => {
  it.each(['webgpu', 'webgl2'] as const)(
    'serves accessibility-on output with owned text rows and reads styled cells only for public snapshots (%s)',
    async (backend) => {
      const harness = await createObservedRendererHarness({ accessibility: {} }, backend)
      const styled = `${escape}[1;38;2;12;34;56mABC${escape}[0m`
      harness.terminal.write(styled)
      await settleTerminal(harness.terminal)

      expect(harness.renderer.metrics.zigFrames).toBeGreaterThan(0)
      expect(harness.readRowsCalls()).toBe(0)
      expect(harness.readTextRowsCalls()).toBeGreaterThan(0)
      expect(harness.host.querySelector('[role="listitem"]')?.textContent).toBe('ABC')
      expect(harness.snapshots.at(-1)?.rows.every((row) => !('renderCells' in row))).toBe(true)
      const textFrame = harness.snapshots.at(-1)!
      const retainedTextRows = structuredClone(textFrame.rows)
      const textReads = harness.readTextRowsCalls()
      expect(harness.terminal.visibleLines()[0]?.trimEnd()).toBe('ABC')
      expect(harness.readTextRowsCalls()).toBe(textReads)
      const full = harness.terminal.frameSnapshot()!
      expect(harness.readRowsCalls()).toBe(1)
      expect(full.rows[0]?.renderCells[0]).toMatchObject({
        text: 'A',
        foreground: { r: 12, g: 34, b: 56 },
        style: { bold: true },
      })
      expect(full.rows[0]?.continuations.slice(0, 3)).toEqual([false, false, false])

      harness.terminal.write(`${escape}[2J${escape}[Hnew output`)
      await settleTerminal(harness.terminal)
      expect(harness.host.querySelector('[role="listitem"]')?.textContent).toBe('new output')
      expect(harness.readRowsCalls()).toBe(1)
      expect(harness.readTextRowsCalls()).toBeGreaterThan(textReads)
      harness.terminal.dispose()

      expect(textFrame.rows).toEqual(retainedTextRows)
      expect(full.rows[0]?.text.trimEnd()).toBe('ABC')
      expect(full.rows[0]?.renderCells[0]?.foreground).toEqual({ r: 12, g: 34, b: 56 })
    },
  )

  it.each(['webgpu', 'webgl2'] as const)(
    'publishes concealed text changes with identical native GPU records (%s)',
    async (backend) => {
      const harness = await createObservedRendererHarness({ accessibility: {} }, backend)
      const scheduler = Reflect.get(harness.renderer, 'scheduler') as RenderScheduler
      const changedRows: Array<readonly number[]> = []
      harness.terminal.onFrame((event) => changedRows.push(event.rows))
      harness.terminal.write(`${escape}[?25l${escape}[8mA${escape}[H`)
      scheduler.flush()
      expect(harness.renderer.metrics.zigFrames).toBeGreaterThan(0)
      expect(harness.readRowsCalls()).toBe(0)
      expect(harness.terminal.visibleLines()[0]?.trimEnd()).toBe('A')
      expect(harness.host.querySelector('[role="listitem"]')?.textContent).toBe('A')
      const retained = harness.terminal.frameSnapshot()!
      const retainedText = harness.snapshots.at(-1)!
      const textFrames = harness.snapshots.length
      const textReads = harness.readTextRowsCalls()
      const pixels =
        backend === 'webgl2' ? await displayedPixels(harness.terminal.canvas!) : undefined
      const { submittedFrames, uploadedBytes, instanceUploadOperations } = harness.renderer.metrics

      harness.terminal.write(`B${escape}[H`)
      scheduler.flush()

      expect(harness.snapshots.length).toBe(textFrames + 1)
      expect(harness.snapshots.at(-1)?.rows[0]?.text.trimEnd()).toBe('B')
      expect(harness.readTextRowsCalls()).toBeGreaterThan(textReads)
      expect(harness.readRowsCalls()).toBe(1)
      expect(harness.terminal.visibleLines()[0]?.trimEnd()).toBe('B')
      expect(harness.host.querySelector('[role="listitem"]')?.textContent).toBe('B')
      expect(harness.terminal.frameSnapshot()?.rows[0]?.text.trimEnd()).toBe('B')
      expect(retained.rows[0]?.text.trimEnd()).toBe('A')
      expect(retainedText.rows[0]?.text.trimEnd()).toBe('A')
      expect(changedRows.at(-1)).toEqual([0])
      expect(Object.isFrozen(changedRows.at(-1))).toBe(true)
      expect(harness.renderer.metrics.uploadedBytes).toBe(uploadedBytes)
      expect(harness.renderer.metrics.instanceUploadOperations).toBe(instanceUploadOperations)
      if (backend === 'webgl2') {
        expect(harness.renderer.metrics.submittedFrames).toBe(submittedFrames)
        expect(await displayedPixels(harness.terminal.canvas!)).toEqual(pixels)
        expect(harness.renderer.metrics.submittedFrames).toBe(submittedFrames)
      }
    },
  )

  it.each(['webgpu', 'webgl2'] as const)(
    'keeps idle Zig frames row-free while positioning the cursor and publishing changed row IDs (%s)',
    async (backend) => {
      const harness = await createObservedRendererHarness({}, backend)
      const changedRows: Array<readonly number[]> = []
      harness.terminal.onFrame((event) => changedRows.push(event.rows))

      harness.terminal.write('first\r\nsecond')
      await settleTerminal(harness.terminal)

      expect(harness.renderer.metrics.zigFrames).toBeGreaterThan(0)
      expect(harness.readRowsCalls()).toBe(0)
      expect(harness.readTextRowsCalls()).toBe(0)
      expect(harness.snapshots.length).toBeGreaterThan(0)
      expect(harness.snapshots.every((snapshot) => snapshot.rows.length === 0)).toBe(true)
      expect(changedRows.at(-1)).toEqual([0, 1])
      expect(Object.isFrozen(changedRows.at(-1))).toBe(true)
      expect(harness.snapshots.at(-1)?.cursor.viewport).toMatchObject({ x: 6, y: 1 })
      expect(Number.parseFloat(harness.terminal.textarea!.style.left)).toBe(
        6 * harness.terminal.appearance.grid.cellWidth,
      )
      expect(Number.parseFloat(harness.terminal.textarea!.style.top)).toBe(
        harness.terminal.appearance.grid.cellHeight,
      )

      const firstChangedRows = changedRows.at(-1)
      harness.terminal.write(`${escape}[1;1HX`)
      await settleTerminal(harness.terminal)

      expect(changedRows.at(-1)).toEqual([0, 1])
      expect(firstChangedRows).toEqual([0, 1])
      expect(harness.readRowsCalls()).toBe(0)
      if (backend === 'webgl2') {
        const pixels = await displayedPixels(harness.terminal.canvas!)
        expect(new Set(pixels).size).toBeGreaterThan(1)
        const submittedFrames = harness.renderer.metrics.submittedFrames
        const textFrames = harness.snapshots.length
        harness.terminal.refresh(0, 0)
        await settleTerminal(harness.terminal)
        expect(harness.renderer.metrics.submittedFrames).toBe(submittedFrames)
        expect(harness.snapshots.length).toBeGreaterThan(textFrames)
        expect(harness.snapshots.at(-1)?.rows).toEqual([])
        expect(harness.readRowsCalls()).toBe(0)
        expect(harness.readTextRowsCalls()).toBe(0)
        expect(await displayedPixels(harness.terminal.canvas!)).toEqual(pixels)
        expect(harness.renderer.metrics.submittedFrames).toBe(submittedFrames)
      }
    },
  )

  it.each(['webgpu', 'webgl2'] as const)(
    'lazily owns styled snapshot rows and keeps pre-paint reads on the previously painted content (%s)',
    async (backend) => {
      const harness = await createObservedRendererHarness({}, backend)
      const styled = `${escape}[1;3;4;38;2;12;34;56;48;2;65;43;21mA界B${escape}[0m`
      const reference = await createSession({ appearance: { grid: { columns: 30, rows: 4 } } })
      reference.write(styled)
      reference.renderState.update()
      const expectedCells = reference.renderState.readRows().map((row) => row.cells)
      const zigFrames = harness.renderer.metrics.zigFrames
      harness.terminal.write(styled)
      await settleTerminal(harness.terminal)
      expect(harness.renderer.metrics.zigFrames).toBe(zigFrames + 1)
      expect(harness.readRowsCalls()).toBe(0)
      expect(harness.readTextRowsCalls()).toBe(0)
      expect(harness.snapshots.at(-1)?.rows).toEqual([])
      const renderingReads = harness.readRowsCalls()
      const updates = harness.updateCalls()

      harness.terminal.write(`${escape}[2J${escape}[Hreplacement`)
      const visible = harness.terminal.visibleLines()
      const retained = harness.terminal.frameSnapshot()!
      const retainedRows = structuredClone(retained.rows)

      expect(harness.updateCalls()).toBe(updates)
      expect(harness.readRowsCalls()).toBe(renderingReads + 1)
      expect(harness.readTextRowsCalls()).toBe(1)
      expect(visible[0]?.trimEnd()).toBe('A界B')
      expect(retained.rows.map((row) => row.renderCells)).toEqual(expectedCells)
      expect(retained.rows[0]?.continuations.slice(0, 4)).toEqual([false, false, true, false])
      expect(retained.rows[0]?.renderCells[0]).toMatchObject({
        background: { r: 65, g: 43, b: 21 },
        foreground: { r: 12, g: 34, b: 56 },
        style: { bold: true, italic: true, underline: 1 },
        text: 'A',
      })
      expect(Object.isFrozen(retained.rows[0]?.renderCells[0]?.style)).toBe(true)

      await settleTerminal(harness.terminal)
      expect(harness.readRowsCalls()).toBe(renderingReads + 1)
      expect(harness.terminal.visibleLines()[0]?.trimEnd()).toBe('replacement')
      expect(harness.readRowsCalls()).toBe(renderingReads + 1)
      expect(harness.readTextRowsCalls()).toBe(2)
      harness.terminal.write(`${escape}[2J${escape}[Hlater`)
      await settleTerminal(harness.terminal)
      expect(harness.terminal.frameSnapshot()?.rows[0]?.text.trimEnd()).toBe('later')
      harness.terminal.dispose()

      expect(retained.rows).toEqual(retainedRows)
      expect(visible[0]?.trimEnd()).toBe('A界B')
    },
  )

  it.each([{ backend: 'webgpu' }, { backend: 'webgl2' }] as const)(
    'commits atlas-eviction recovery in one paint before lazy snapshots read the captured state ($backend)',
    async ({ backend }) => {
      const harness = await createObservedRendererHarness({}, backend)
      const onError = vi.fn()
      harness.terminal.on('error', onError)
      const renderer = harness.renderer
      const rasterizer = Reflect.get(renderer, 'rasterizer') as CanvasGlyphRasterizer
      const bitmaps = Array.from('ABCDE界', (text) => {
        const bitmap = rasterizer.rasterize({
          cellSpan: text === '界' ? 2 : 1,
          foreground: harness.terminal.appearance.rendererTheme.foreground,
          italic: false,
          text,
          weight: 'normal',
        })
        if (!bitmap) throw new TypeError('Expected a visible atlas glyph')
        return bitmap
      })
      const initialWidth = bitmaps.slice(0, 4).reduce((width, bitmap) => width + bitmap.width, 5)
      const retryWidth = bitmaps[0]!.width + bitmaps[4]!.width + 3
      const atlas = new GlyphAtlas({
        maxLayersPerKind: 1,
        pageHeight: Math.max(...bitmaps.map((bitmap) => bitmap.height)) + 2,
        pageWidth: Math.max(initialWidth, retryWidth),
      })
      Reflect.set(renderer, 'atlas', atlas)
      if (renderer instanceof WebGlTerminalRenderer) {
        const previousState = Reflect.get(renderer, 'state') as { pass: WebGlTextPass }
        const canvas = harness.terminal.canvas!
        const pass = new WebGlTextPass({
          atlasLayout: atlas.textureLayout,
          context: Reflect.get(renderer, 'context') as WebGL2RenderingContext,
          height: canvas.height,
          instanceCount:
            harness.terminal.appearance.grid.columns * harness.terminal.appearance.grid.rows,
          width: canvas.width,
        })
        Reflect.set(renderer, 'state', { kind: 'ready', pass })
        previousState.pass.destroy()
      } else {
        const previousTextures = Reflect.get(renderer, 'atlasTextures') as AtlasGpuTextures
        const textures = new AtlasGpuTextures(
          Reflect.get(renderer, 'device') as GPUDevice,
          atlas.textureLayout,
        )
        Reflect.set(renderer, 'atlasTextures', textures)
        const textPass = Reflect.get(renderer, 'textPass') as WebGpuTextPass
        textPass.syncAtlas(textures)
        previousTextures.destroy()
      }
      const scheduler = Reflect.get(renderer, 'scheduler') as RenderScheduler
      harness.terminal.write('AAA\r\nBCD')
      scheduler.flush()
      expect(atlas.evictionCount).toBe(0)
      expect(renderer.metrics.zigFrames).toBeGreaterThan(0)
      const paintedFrames = harness.snapshots.length
      const submittedFrames = renderer.metrics.submittedFrames

      harness.terminal.write(`${escape}[2;1HEEE`)
      scheduler.flush()

      expect(atlas.evictionCount).toBeGreaterThan(0)
      expect(renderer.metrics.submittedFrames).toBe(submittedFrames + 1)
      expect(harness.snapshots.length).toBe(paintedFrames + 1)
      expect(harness.terminal.hasPendingFrame).toBe(false)
      const snapshot = harness.terminal.frameSnapshot()!
      expect(snapshot.rows.slice(0, 2).map((row) => row.text.trimEnd())).toEqual(['AAA', 'EEE'])
      expect(snapshot.cursor.viewport).toMatchObject({ x: 3, y: 1 })
      expect(harness.snapshots.at(-1)?.rows).toEqual([])
      expect(harness.readTextRowsCalls()).toBe(0)
      expect(atlas.rowsWithStaleReferences()).toEqual([])
      const rebuiltRows = renderer.metrics.rebuiltRows
      const styledReads = harness.readRowsCalls()
      const zigFrames = renderer.metrics.zigFrames
      harness.terminal.write(`${escape}[1;1H界ABCDE`)
      expect(() => scheduler.flush()).not.toThrow()
      expect(onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ cause: expect.objectContaining({ operation: 'frame_builder' }) }),
      )
      expect(harness.readRowsCalls()).toBe(styledReads)
      expect(renderer.metrics.submittedFrames).toBe(submittedFrames + 1)
      expect(harness.terminal.frameSnapshot()).toBe(snapshot)
      expect(
        harness.terminal
          .visibleLines()
          .slice(0, 2)
          .map((text) => text.trimEnd()),
      ).toEqual(['AAA', 'EEE'])

      harness.terminal.write(`${escape}[1;1HC${escape}[K`)
      scheduler.flush()

      expect(renderer.metrics.submittedFrames).toBe(submittedFrames + 2)
      expect(renderer.metrics.zigFrames).toBe(zigFrames + 1)
      expect(renderer.metrics.rebuiltRows - rebuiltRows).toBe(harness.terminal.appearance.grid.rows)
      expect(
        harness.terminal
          .visibleLines()
          .slice(0, 2)
          .map((text) => text.trimEnd()),
      ).toEqual(['C', 'EEE'])
      expect(harness.terminal.frameSnapshot()?.cursor.viewport).toMatchObject({ x: 1, y: 0 })
      expect(atlas.rowsWithStaleReferences()).toEqual([])
      const recoveryPixels = await renderer.capturePixels()
      renderer.clearTextureAtlas()
      scheduler.flush()
      expect(await renderer.capturePixels()).toEqual(recoveryPixels)
    },
  )

  it('retains acquired styled rows and cursor when native state advances without a successful paint', async () => {
    const harness = await createObservedRendererHarness()
    const session = Reflect.get(harness.terminal, 'session') as TerminalSession<Event>
    harness.terminal.write(`${escape}[1;38;2;12;34;56mold${escape}[0m`)
    await settleTerminal(harness.terminal)
    const retained = harness.terminal.frameSnapshot()!
    const visible = harness.terminal.visibleLines()
    const rowReads = harness.readRowsCalls()
    const textReads = harness.readTextRowsCalls()
    const version = session.renderState.snapshotVersion!

    harness.terminal.write(`${escape}[2J${escape}[Hnew output\r\nnext`)
    session.renderState.update()

    expect(session.renderState.snapshotVersion).toBeGreaterThan(version)
    expect(harness.terminal.frameSnapshot()).toBe(retained)
    expect(harness.terminal.visibleLines()).toEqual(visible)
    expect(retained.rows[0]?.text.trimEnd()).toBe('old')
    expect(retained.rows[0]?.renderCells[0]?.style?.bold).toBe(true)
    expect(retained.cursor.viewport).toMatchObject({ x: 3, y: 0 })
    expect(harness.readRowsCalls()).toBe(rowReads)
    expect(harness.readTextRowsCalls()).toBe(textReads)
    expect(harness.terminal.captureViewport()).toBeUndefined()
    await settleTerminal(harness.terminal)

    const current = harness.terminal.frameSnapshot()!
    expect(current.rows[0]?.text.trimEnd()).toBe('new output')
    expect(current.rows[1]?.text.trimEnd()).toBe('next')
    expect(current.cursor.viewport).toMatchObject({ x: 4, y: 1 })
    expect(retained.rows[0]?.text.trimEnd()).toBe('old')
  })

  it('declines lazy hydration when unpainted native state has replaced the last captured state', async () => {
    const harness = await createObservedRendererHarness()
    const session = Reflect.get(harness.terminal, 'session') as TerminalSession<Event>
    harness.terminal.write('old')
    await settleTerminal(harness.terminal)
    expect(harness.readRowsCalls()).toBe(0)
    expect(harness.readTextRowsCalls()).toBe(0)

    harness.terminal.write(`${escape}[2J${escape}[Hnew output`)
    session.renderState.update()

    expect(harness.terminal.frameSnapshot()).toBeUndefined()
    expect(harness.terminal.visibleLines()).toEqual([])
    expect(harness.terminal.captureViewport()).toBeUndefined()
    expect(harness.readRowsCalls()).toBe(0)
    expect(harness.readTextRowsCalls()).toBe(0)
    await settleTerminal(harness.terminal)

    expect(harness.terminal.visibleLines()[0]?.trimEnd()).toBe('new output')
    expect(harness.terminal.frameSnapshot()?.cursor.viewport).toMatchObject({ x: 10, y: 0 })
  })

  it('hydrates accessibility immediately from the last painted idle frame and releases demand when disabled', async () => {
    const harness = await createObservedRendererHarness()
    harness.terminal.write('accessible now')
    await settleTerminal(harness.terminal)
    expect(harness.readRowsCalls()).toBe(0)
    const updates = harness.updateCalls()

    expect(harness.terminal.setAccessibilityEnabled(true)).toBe(true)
    expect(harness.host.querySelector('[role="listitem"]')?.textContent).toBe('accessible now')
    expect(harness.readRowsCalls()).toBe(0)
    expect(harness.readTextRowsCalls()).toBe(1)
    expect(harness.updateCalls()).toBe(updates)

    harness.terminal.write('!')
    await settleTerminal(harness.terminal)
    expect(harness.host.querySelector('[role="listitem"]')?.textContent).toBe('accessible now!')
    expect(harness.snapshots.at(-1)?.rows).toHaveLength(4)
    expect(harness.terminal.setAccessibilityEnabled(false)).toBe(true)
    const reads = harness.readTextRowsCalls()
    harness.terminal.write('?')
    await settleTerminal(harness.terminal)

    expect(harness.readRowsCalls()).toBe(0)
    expect(harness.readTextRowsCalls()).toBe(reads)
    expect(harness.snapshots.at(-1)?.rows).toEqual([])
  })

  it('resolves the latest output on first hover after uninterested frames and stops reading on pointer leave', async () => {
    const harness = await createObservedRendererHarness()
    harness.terminal.write('https://old.test')
    await settleTerminal(harness.terminal)
    harness.terminal.write(`${escape}[2J${escape}[Hhttps://fresh.test`)
    await settleTerminal(harness.terminal)
    expect(harness.readRowsCalls()).toBe(0)

    moveTerminalPointer(harness.terminal, 5, 0)
    await waitForUi(
      () =>
        harness.host.querySelector('[role="link"]')?.getAttribute('aria-label') ===
        'https://fresh.test',
      'First hover did not hydrate the current idle viewport',
    )
    expect(harness.readRowsCalls()).toBe(0)
    expect(harness.readTextRowsCalls()).toBe(1)
    harness.terminal.write(`${escape}[2J${escape}[Hhttps://hover.test`)
    await settleTerminal(harness.terminal)
    await waitForUi(
      () =>
        harness.host.querySelector('[role="link"]')?.getAttribute('aria-label') ===
        'https://hover.test',
      'Active hover did not track the next output frame',
    )
    expect(harness.snapshots.at(-1)?.rows).toHaveLength(4)
    harness.terminal.canvas!.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }))
    const reads = harness.readTextRowsCalls()
    harness.terminal.write(`${escape}[2J${escape}[Hhttps://idle-again.test`)
    await settleTerminal(harness.terminal)

    expect(harness.host.querySelector('[role="link"]')).toBeNull()
    expect(harness.readRowsCalls()).toBe(0)
    expect(harness.readTextRowsCalls()).toBe(reads)
    expect(harness.snapshots.at(-1)?.rows).toEqual([])
  })

  it.each(
    (['webgpu', 'webgl2'] as const).flatMap((backend) =>
      [
        { label: 'bell', output: '\u0007' },
        { label: 'title', output: `${escape}]0;clean title\u0007` },
      ].flatMap(({ label, output }) =>
        (['hover', 'keyboard'] as const).map((discovery) => ({
          backend,
          discovery,
          label,
          output,
        })),
      ),
    ),
  )(
    'permits first $discovery discovery after a clean $label update ($backend)',
    async ({ backend, discovery, output }) => {
      const harness = await createObservedRendererHarness({}, backend)
      const scheduler = Reflect.get(harness.renderer, 'scheduler') as RenderScheduler
      const changedRows: Array<readonly number[]> = []
      harness.terminal.onFrame((event) => changedRows.push(event.rows))
      harness.terminal.write('https://clean.test')
      scheduler.flush()
      const frames = harness.snapshots.length
      const rowEvents = changedRows.length
      const submittedFrames = harness.renderer.metrics.submittedFrames
      const uploadedBytes = harness.renderer.metrics.uploadedBytes
      expect(harness.readRowsCalls()).toBe(0)
      expect(harness.readTextRowsCalls()).toBe(0)

      harness.terminal.write(output)
      await expect(harness.terminal.focusNextLink()).resolves.toBe(false)
      scheduler.flush()

      expect(harness.snapshots.length).toBe(frames)
      expect(changedRows).toHaveLength(rowEvents)
      expect(harness.renderer.metrics.submittedFrames).toBe(submittedFrames)
      expect(harness.renderer.metrics.uploadedBytes).toBe(uploadedBytes)
      expect(harness.readRowsCalls()).toBe(0)
      expect(harness.readTextRowsCalls()).toBe(0)
      if (discovery === 'keyboard') {
        await expect(harness.terminal.focusNextLink()).resolves.toBe(true)
      } else {
        moveTerminalPointer(harness.terminal, 5, 0)
        await waitForUi(
          () => harness.host.querySelector('[role="link"]') !== null,
          'Clean update blocked first hover discovery',
        )
      }
      expect(harness.host.querySelector('[role="link"]')?.getAttribute('aria-label')).toBe(
        'https://clean.test',
      )
      expect(harness.readRowsCalls()).toBe(0)
      expect(harness.readTextRowsCalls()).toBe(1)
    },
  )

  it.each(['webgpu', 'webgl2'] as const)(
    'rejects queued real output during a reentrant clean-update callback (%s)',
    async (backend) => {
      let queued: (() => void) | undefined
      const harness = await createObservedRendererHarness({}, backend, () => queued?.())
      const scheduler = Reflect.get(harness.renderer, 'scheduler') as RenderScheduler
      harness.terminal.write('https://old.test')
      scheduler.flush()
      const updates = harness.updateCalls()
      queued = () => {
        queued = undefined
        harness.terminal.write(`${escape}[2J${escape}[Hreplacement without links`)
      }

      harness.terminal.write('\u0007')
      scheduler.flush()

      expect(harness.terminal.hasPendingFrame).toBe(true)
      await expect(harness.terminal.focusNextLink()).resolves.toBe(false)
      expect(harness.updateCalls()).toBe(updates + 1)
      expect(harness.readTextRowsCalls()).toBe(0)
      scheduler.flush()
      await expect(harness.terminal.focusNextLink()).resolves.toBe(false)
      harness.terminal.write(`${escape}[2J${escape}[Hhttps://fresh.test`)
      scheduler.flush()
      await expect(harness.terminal.focusNextLink()).resolves.toBe(true)
      expect(harness.host.querySelector('[role="link"]')?.getAttribute('aria-label')).toBe(
        'https://fresh.test',
      )
    },
  )

  it.each(['webgpu', 'webgl2'] as const)(
    'rejects synchronous stale link acquisition during a deferred nested clean-update flush (%s)',
    async (backend) => {
      let queued: (() => void) | undefined
      let inspect: (() => void) | undefined
      const harness = await createObservedRendererHarness(
        {},
        backend,
        () => queued?.(),
        () => inspect?.(),
      )
      const scheduler = Reflect.get(harness.renderer, 'scheduler') as RenderScheduler
      const session = Reflect.get(harness.terminal, 'session') as TerminalSession<Event>
      const links = Reflect.get(harness.terminal, 'links') as DomLinkController
      const linkOptions = Reflect.get(links, 'options') as {
        getFrame(): RendererTextFrameSnapshot | undefined
      }
      harness.terminal.write('https://old.test')
      scheduler.flush()
      const version = session.renderState.snapshotVersion
      const updates = harness.updateCalls()
      let acquired: RendererTextFrameSnapshot | undefined
      let pending: boolean | undefined
      let observedVersion: number | undefined
      queued = () => {
        queued = undefined
        harness.terminal.write(`${escape}[2J${escape}[Hreplacement without links`)
        scheduler.flush()
      }
      inspect = () => {
        inspect = undefined
        pending = harness.terminal.hasPendingFrame
        observedVersion = session.renderState.snapshotVersion
        acquired = linkOptions.getFrame()
      }

      harness.terminal.write('\u0007')
      scheduler.flush()

      expect(observedVersion).toBe(version)
      expect({ pending, text: acquired?.rows[0]?.text.trimEnd() }).toEqual({
        pending: true,
        text: undefined,
      })
      expect(acquired).toBeUndefined()
      expect(harness.updateCalls()).toBe(updates + 2)
      expect(harness.terminal.hasPendingFrame).toBe(false)
      expect(harness.readTextRowsCalls()).toBe(0)
      await expect(harness.terminal.focusNextLink()).resolves.toBe(false)
      harness.terminal.write(`${escape}[2J${escape}[Hhttps://fresh.test`)
      scheduler.flush()
      await expect(harness.terminal.focusNextLink()).resolves.toBe(true)
      expect(harness.host.querySelector('[role="link"]')?.getAttribute('aria-label')).toBe(
        'https://fresh.test',
      )
    },
  )

  it.each(['webgpu', 'webgl2'] as const)(
    'keeps a reentrant replacement write unsettled when clean-update callback hides the document (%s)',
    async (backend) => {
      let queued: (() => void) | undefined
      const harness = await createObservedRendererHarness({}, backend, () => queued?.())
      const scheduler = Reflect.get(harness.renderer, 'scheduler') as RenderScheduler
      const session = Reflect.get(harness.terminal, 'session') as TerminalSession<Event>
      harness.terminal.write('https://old.test')
      scheduler.flush()
      const updates = harness.updateCalls()
      const version = session.renderState.snapshotVersion
      queued = () => {
        queued = undefined
        harness.terminal.write(`${escape}[2J${escape}[Hhttps://replacement.test`)
        harness.renderer.setDocumentVisible(false)
      }

      harness.terminal.write('\u0007')
      scheduler.flush()

      expect(harness.updateCalls()).toBe(updates + 1)
      expect(session.renderState.snapshotVersion).toBe(version)
      expect(harness.terminal.hasPendingFrame).toBe(false)
      const discovery = await harness.terminal.focusNextLink()
      expect({
        discovery,
        label: harness.host.querySelector('[role="link"]')?.getAttribute('aria-label'),
        textReads: harness.readTextRowsCalls(),
      }).toEqual({ discovery: false, label: undefined, textReads: 0 })
      harness.renderer.setDocumentVisible(true)
      scheduler.flush()
      await expect(harness.terminal.focusNextLink()).resolves.toBe(true)
      expect(harness.host.querySelector('[role="link"]')?.getAttribute('aria-label')).toBe(
        'https://replacement.test',
      )
    },
  )

  it.each(['webgpu', 'webgl2'] as const)(
    'keeps hidden-document output unsettled until its real paint (%s)',
    async (backend) => {
      const harness = await createObservedRendererHarness({}, backend)
      const scheduler = Reflect.get(harness.renderer, 'scheduler') as RenderScheduler
      harness.terminal.write('https://old.test')
      scheduler.flush()
      const updates = harness.updateCalls()
      harness.renderer.setDocumentVisible(false)
      harness.terminal.write(`${escape}[2J${escape}[Hhttps://hidden.test`)
      scheduler.flush()

      expect(harness.terminal.hasPendingFrame).toBe(false)
      expect(harness.updateCalls()).toBe(updates)
      await expect(harness.terminal.focusNextLink()).resolves.toBe(false)
      expect(harness.readTextRowsCalls()).toBe(0)
      harness.renderer.setDocumentVisible(true)
      scheduler.flush()
      await expect(harness.terminal.focusNextLink()).resolves.toBe(true)
      expect(harness.host.querySelector('[role="link"]')?.getAttribute('aria-label')).toBe(
        'https://hidden.test',
      )
    },
  )

  it('repaints a revision-advancing fit and permits link discovery after its new frame', async () => {
    const harness = await createObservedRendererHarness()
    const session = Reflect.get(harness.terminal, 'session') as TerminalSession<Event>
    harness.terminal.write('https://resize.test')
    await settleTerminal(harness.terminal)
    const revision = session.revision
    const paintedFrames = harness.snapshots.length
    const columns = harness.terminal.appearance.grid.columns
    const font = fitTerminalFont(
      document,
      harness.terminal.appearance.font,
      window.devicePixelRatio,
    )

    harness.host.style.width = `${Math.ceil(font.cssCellWidth * (columns + 5) + 12)}px`
    await waitForUi(() => session.revision > revision, 'Fit did not advance the session revision')
    await settleTerminal(harness.terminal)

    expect(harness.terminal.appearance.grid.columns).toBe(columns + 5)
    expect(harness.snapshots.length).toBeGreaterThan(paintedFrames)
    await expect(harness.terminal.focusNextLink()).resolves.toBe(true)
    expect(harness.host.querySelector('[role="link"]')?.getAttribute('aria-label')).toBe(
      'https://resize.test',
    )
  })

  it('rejects keyboard discovery from an old painted link while replacement output awaits paint', async () => {
    const harness = await createObservedRendererHarness()
    harness.terminal.write('https://old.test')
    await settleTerminal(harness.terminal)
    const updates = harness.updateCalls()
    expect(harness.readTextRowsCalls()).toBe(0)

    harness.terminal.write(`${escape}[2J${escape}[Hreplacement without links`)
    await expect(harness.terminal.focusNextLink()).resolves.toBe(false)

    expect(harness.host.querySelector('[role="link"]')).toBeNull()
    expect(harness.readRowsCalls()).toBe(0)
    expect(harness.readTextRowsCalls()).toBe(0)
    expect(harness.updateCalls()).toBe(updates)
    await settleTerminal(harness.terminal)
    await expect(harness.terminal.focusNextLink()).resolves.toBe(false)
    expect(harness.host.querySelector('[role="link"]')).toBeNull()

    harness.terminal.write(`${escape}[2J${escape}[Hhttps://new.test`)
    await settleTerminal(harness.terminal)
    await expect(harness.terminal.focusNextLink()).resolves.toBe(true)
    expect(harness.host.querySelector('[role="link"]')?.getAttribute('aria-label')).toBe(
      'https://new.test',
    )
  })

  it('preserves async keyboard discovery and the focused overlay through equivalent painted frames', async () => {
    const harness = await createObservedRendererHarness()
    const pending = deferred<readonly ProvidedLink<Event>[] | undefined>()
    let providerCalls = 0
    harness.terminal.registerLinkProvider({
      provideLinks: () => {
        providerCalls += 1
        return pending.promise
      },
    })
    harness.terminal.write('discover me')
    await settleTerminal(harness.terminal)
    expect(harness.readRowsCalls()).toBe(0)

    const discovery = harness.terminal.focusNextLink()
    expect(harness.terminal.diagnostics.hasPendingLinkResolution).toBe(true)
    harness.terminal.refresh(0, 0)
    await settleTerminal(harness.terminal)
    expect(harness.snapshots.at(-1)?.rows).toHaveLength(4)
    expect(harness.terminal.diagnostics.hasPendingLinkResolution).toBe(true)
    pending.resolve([{ activate: () => {}, range: { start: 0, end: 10 }, text: 'discovered link' }])
    await expect(discovery).resolves.toBe(true)
    const overlay = harness.host.querySelector<HTMLElement>('[role="link"]')!
    expect(overlay.getAttribute('aria-label')).toBe('discovered link')
    expect(harness.host.ownerDocument.activeElement).toBe(overlay)
    expect(providerCalls).toBe(1)

    harness.terminal.refresh(0, 0)
    await settleTerminal(harness.terminal)

    expect(harness.host.querySelector('[role="link"]')).toBe(overlay)
    expect(harness.host.ownerDocument.activeElement).toBe(overlay)
    expect(providerCalls).toBe(1)
    expect(harness.terminal.diagnostics.hasPendingLinkResolution).toBe(false)
  })

  it('measures cursor-only caret reads, text-only accessibility, and link cells without styled cell access', async () => {
    const idle = await createIntegratedHarness({ accessibility: false })
    const idleFrame = measuredFrame(['https://measured.test'])
    idle.renderer.emit(idleFrame.snapshot)
    expect(idleFrame.reads.cursor).toBeGreaterThan(0)
    expect(idleFrame.reads).toMatchObject({
      cells: 0,
      continuations: 0,
      renderCells: 0,
      text: 0,
      y: 0,
    })

    const accessible = await createIntegratedHarness()
    const accessibleFrame = measuredFrame(['https://measured.test'])
    accessible.renderer.emit(accessibleFrame.snapshot)
    expect(accessibleFrame.reads.text).toBeGreaterThan(0)
    expect(accessibleFrame.reads.y).toBeGreaterThan(0)
    expect(accessibleFrame.reads).toMatchObject({ cells: 0, continuations: 0, renderCells: 0 })

    moveTerminalPointer(idle.terminal, 5, 0)
    await waitForUi(
      () => idle.host.querySelector('[role="link"]') !== null,
      'Measured frame did not resolve on pointer demand',
    )
    expect(idleFrame.reads.cells).toBeGreaterThan(0)
    expect(idleFrame.reads.continuations).toBeGreaterThan(0)
    expect(idleFrame.reads.renderCells).toBe(0)
  })
})

describe('integrated terminal UI host', () => {
  it('accepts a pre-fit frame and resolves links after the post-fit repaint', async () => {
    const context = document.createElement('canvas').getContext('2d')
    if (!context) throw new TypeError('Expected a 2D canvas context')
    const pixelRatio = window.devicePixelRatio
    context.font = '14px monospace'
    const cellWidth = Math.round(context.measureText('M').width * pixelRatio) / pixelRatio
    const cellHeight = Math.round(14 * 1.2 * pixelRatio) / pixelRatio
    const host = appendRoot(Math.ceil(cellWidth * 30 + 12), Math.ceil(cellHeight * 4))
    const text = 'https://early-frame.test'
    let renderer: FrameRenderer | undefined
    const terminal = await Terminal.create({
      appearance: {
        cursor: { blink: false },
        grid: { cellHeight, cellWidth, columns: 30, pixelRatio, rows: 4 },
      },
      rendererFactory: async (options) => {
        const canvas = options.canvas
        if (!(canvas instanceof HTMLCanvasElement)) throw new TypeError('Expected an HTML canvas')
        options.onTextFrame?.(frame([text, '', '', '']))
        renderer = new FrameRenderer(canvas, options.onTextFrame, options)
        return renderer
      },
      runtime: { kind: 'borrowed', runtime },
    })
    cleanups.push(() => terminal.dispose())

    await terminal.open(host)
    await settleTerminal(terminal)
    renderer!.emit(
      frame(
        Array.from({ length: terminal.appearance.grid.rows }, (_, row) => (row === 0 ? text : '')),
      ),
    )
    moveTerminalPointer(terminal, 5, 0)
    await waitForUi(
      () => host.querySelector('[role="link"]')?.getAttribute('aria-label') === text,
      'Post-fit frame did not resolve the visible link',
    )

    expect(renderer).toBeDefined()
  })

  it('replays the last frame when an idle link provider is registered or disposed', async () => {
    const harness = await createIntegratedHarness()
    const text = 'https://idle-provider.test'
    harness.terminal.write(text)
    harness.renderer.emit(frame([text]))
    moveTerminalPointer(harness.terminal, 5, 0)
    await waitForUi(
      () => harness.host.querySelector('[role="link"]')?.getAttribute('aria-label') === text,
      'Built-in link did not resolve',
    )
    expect(harness.renderer.emittedFrames).toBe(1)

    const registration = harness.terminal.registerLinkProvider({
      provideLinks: () => [
        {
          activate: () => {},
          range: { end: text.length - 1, start: 0 },
          text: 'provider link',
        },
      ],
    })
    await waitForUi(
      () =>
        harness.host.querySelector('[role="link"]')?.getAttribute('aria-label') === 'provider link',
      'Registered provider did not replay the last frame',
    )
    expect(harness.renderer.emittedFrames).toBe(1)

    registration.dispose()
    await waitForUi(
      () => harness.host.querySelector('[role="link"]')?.getAttribute('aria-label') === text,
      'Disposed provider did not restore the built-in link',
    )
    expect(harness.renderer.emittedFrames).toBe(1)
  })

  it('discovers and activates a visible link using only the explicit keyboard action', async () => {
    const activations: Array<{ event: Event; uri: string }> = []
    const harness = await createIntegratedHarness({
      links: {
        activateUri: (uri, event) => {
          activations.push({ event, uri })
        },
      },
    })
    const text = 'https://keyboard-only.test'
    harness.terminal.write(text)
    harness.renderer.emit(frame([text]))

    await expect(harness.terminal.focusNextLink()).resolves.toBe(true)
    const overlay = harness.host.querySelector<HTMLElement>('[role="link"]')
    expect(overlay?.getAttribute('aria-label')).toBe(text)
    expect(harness.host.ownerDocument.activeElement).toBe(overlay)

    const enter = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
    })
    overlay!.dispatchEvent(enter)
    await waitForUi(() => activations.length === 1, 'Keyboard link activation did not complete')

    expect(enter.defaultPrevented).toBe(true)
    expect(activations).toEqual([{ event: enter, uri: text }])
  })

  it('keeps a modified link click out of native selection', async () => {
    const activations: string[] = []
    const harness = await createIntegratedHarness({
      links: {
        activateUri: (uri) => {
          activations.push(uri)
        },
      },
    })
    const text = 'https://selection-exclusive.test'
    harness.terminal.write(text)
    harness.renderer.emit(frame([text]))
    installPointerCapture(harness.terminal.canvas!)
    moveTerminalPointer(harness.terminal, 5, 0)
    await waitForUi(
      () => harness.host.querySelector('[role="link"]') !== null,
      'Selection-exclusive link did not resolve',
    )
    const selectionEvents: unknown[] = []
    harness.terminal.on('selection', (event) => selectionEvents.push(event))

    const click = dispatchModifiedTerminalClick(harness.terminal, 5, 0)
    await waitForUi(() => activations.length === 1, 'Modified link click did not activate')

    expect(click.defaultPrevented).toBe(true)
    expect(activations).toEqual([text])
    expect(selectionEvents).toEqual([])
    expect(harness.terminal.selectionCoordinates()).toBeUndefined()
  })

  it('keeps a modified link click out of native mouse reporting', async () => {
    const activations: string[] = []
    const harness = await createIntegratedHarness({
      links: {
        activateUri: (uri) => {
          activations.push(uri)
        },
      },
    })
    const text = 'https://mouse-exclusive.test'
    harness.terminal.write(`${escape}[?1000h${escape}[?1006h${text}`)
    harness.renderer.emit(frame([text]))
    installPointerCapture(harness.terminal.canvas!)
    moveTerminalPointer(harness.terminal, 5, 0)
    await waitForUi(
      () => harness.host.querySelector('[role="link"]') !== null,
      'Mouse-exclusive link did not resolve',
    )
    const data: string[] = []
    harness.terminal.onData((bytes) => data.push(decoder.decode(bytes)))

    const click = dispatchModifiedTerminalClick(harness.terminal, 5, 0)
    await waitForUi(() => activations.length === 1, 'Tracked modified link click did not activate')

    expect(click.defaultPrevented).toBe(true)
    expect(activations).toEqual([text])
    expect(data).toEqual([])
  })

  it('clearSelection cancels an active pointer gesture and releases capture', async () => {
    const harness = await createIntegratedHarness()
    harness.terminal.write('clear active gesture')
    harness.renderer.emit(frame(['clear active gesture']))
    const canvas = harness.terminal.canvas!
    const captured = installPointerCapture(canvas)
    const point = terminalCellPoint(harness.terminal, 1, 0)
    dispatchPointer(canvas, 'pointerdown', point.clientX, point.clientY)
    expect(harness.terminal.diagnostics.pointerOwner).toBe('selection')
    expect(captured.has(7)).toBe(true)

    harness.terminal.clearSelection()

    expect(harness.terminal.diagnostics.pointerOwner).toBe('none')
    expect(captured.size).toBe(0)
    expect(harness.terminal.selectionCoordinates()).toBeUndefined()
  })

  it('selectAll cancels an active pointer gesture and releases capture', async () => {
    const harness = await createIntegratedHarness()
    harness.terminal.write('select all active gesture')
    harness.renderer.emit(frame(['select all active gesture']))
    const canvas = harness.terminal.canvas!
    const captured = installPointerCapture(canvas)
    const point = terminalCellPoint(harness.terminal, 1, 0)
    dispatchPointer(canvas, 'pointerdown', point.clientX, point.clientY)
    expect(harness.terminal.diagnostics.pointerOwner).toBe('selection')
    expect(captured.has(7)).toBe(true)

    harness.terminal.selectAll()

    expect(harness.terminal.diagnostics.pointerOwner).toBe('none')
    expect(captured.size).toBe(0)
    expect(harness.terminal.getSelection()).toContain('select all active gesture')
  })

  it('selectRange cancels an active pointer gesture and releases capture', async () => {
    const harness = await createIntegratedHarness()
    harness.terminal.write('select range active gesture')
    harness.renderer.emit(frame(['select range active gesture']))
    const canvas = harness.terminal.canvas!
    const captured = installPointerCapture(canvas)
    const point = terminalCellPoint(harness.terminal, 1, 0)
    dispatchPointer(canvas, 'pointerdown', point.clientX, point.clientY)
    expect(harness.terminal.diagnostics.pointerOwner).toBe('selection')
    expect(captured.has(7)).toBe(true)

    harness.terminal.selectRange({ x: 0, y: 0 }, { x: 5, y: 0 })

    expect(harness.terminal.diagnostics.pointerOwner).toBe('none')
    expect(captured.size).toBe(0)
    expect(harness.terminal.getSelection()).toBe('select')
  })

  it('selectLines cancels an active pointer gesture and releases capture', async () => {
    const harness = await createIntegratedHarness()
    harness.terminal.write('select lines active gesture')
    harness.renderer.emit(frame(['select lines active gesture']))
    const canvas = harness.terminal.canvas!
    const captured = installPointerCapture(canvas)
    const point = terminalCellPoint(harness.terminal, 1, 0)
    dispatchPointer(canvas, 'pointerdown', point.clientX, point.clientY)
    expect(harness.terminal.diagnostics.pointerOwner).toBe('selection')
    expect(captured.has(7)).toBe(true)

    harness.terminal.selectLines(0, 0)

    expect(harness.terminal.diagnostics.pointerOwner).toBe('none')
    expect(captured.size).toBe(0)
    expect(harness.terminal.getSelection()).toContain('select lines active gesture')
  })

  it('enables and disables the accessibility mirror without replacing terminal elements', async () => {
    const harness = await createIntegratedHarness({ accessibility: false })
    const element = harness.terminal.element
    const textarea = harness.terminal.textarea

    expect(harness.host.querySelector('.ghostty-webgpu-accessibility')).toBeNull()
    expect(harness.terminal.setAccessibilityEnabled(false)).toBe(false)
    expect(harness.terminal.setAccessibilityEnabled(true)).toBe(true)
    expect(harness.terminal.element).toBe(element)
    expect(harness.terminal.textarea).toBe(textarea)

    harness.renderer.emit(frame(['accessible row']))
    expect(harness.host.querySelector('[role="listitem"]')?.textContent).toBe('accessible row')
    expect(harness.terminal.setAccessibilityEnabled(true)).toBe(false)
    expect(harness.terminal.setAccessibilityEnabled(false)).toBe(true)
    expect(harness.host.querySelector('.ghostty-webgpu-accessibility')).toBeNull()
    expect(textarea?.hasAttribute('aria-controls')).toBe(false)
  })

  it('preserves native wide-cell continuation in provider and accessibility text', async () => {
    const host = appendRoot(360, 100)
    let providerText: string | undefined
    const terminal = await Terminal.create({
      appearance: {
        cursor: { blink: false },
        grid: { columns: 12, rows: 2 },
      },
      runtime: { kind: 'borrowed', runtime },
    })
    cleanups.push(() => terminal.dispose())
    await terminal.open(host)
    await settleTerminal(terminal)
    terminal.registerLinkProvider({
      provideLinks: (line) => {
        providerText = line.text
        return [{ activate: () => {}, range: { end: 2, start: 0 }, text: 'wide link' }]
      },
    })

    terminal.write('界A')
    await settleTerminal(terminal)
    await waitForUi(
      () => terminal.frameSnapshot()?.rows[0]?.text.startsWith('界A') ?? false,
      'Wide-cell frame did not render',
    )
    moveTerminalPointer(terminal, 2, 0)
    await waitForUi(() => providerText !== undefined, 'Wide-cell provider did not run')

    expect(providerText?.startsWith('界A')).toBe(true)
    expect(host.querySelector('[role="listitem"]')?.textContent).toBe('界A')
  })

  it('emits an error only when an accepted OSC 52 browser completion later fails', async () => {
    const host = appendRoot(320, 100)
    const completion = deferred<void>()
    const failure = new Error('clipboard permission changed')
    const writes: string[] = []
    const errors: Array<{ cause: unknown; operation: string }> = []
    const terminal = await Terminal.create({
      clipboardWrite: (write) => {
        writes.push(decoder.decode(write.contents[0]!.data))
        return { completion: completion.promise, result: 'success' }
      },
      rendererFactory: async (options) => {
        const canvas = options.canvas
        if (!(canvas instanceof HTMLCanvasElement)) throw new TypeError('Expected an HTML canvas')
        return new FrameRenderer(canvas, options.onTextFrame, options)
      },
      runtime: { kind: 'borrowed', runtime },
    })
    cleanups.push(() => terminal.dispose())

    await terminal.open(host)
    terminal.on('error', (event) => errors.push(event))
    terminal.write(`${escape}]52;c;Y29waWVk\u0007`)

    expect(writes).toEqual(['copied'])
    expect(errors).toEqual([])

    completion.reject(failure)
    await Promise.resolve()
    await Promise.resolve()
    expect(errors).toEqual([{ cause: failure, operation: 'clipboardWrite.completion' }])
  })

  it('uses platform copy without stealing non-Apple Ctrl+C and removes UI state on disposal', async () => {
    const host = appendRoot(420, 140)
    const clipboardWrites: string[] = []
    const navigatorObject = host.ownerDocument.defaultView!.navigator
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigatorObject, 'clipboard')
    Object.defineProperty(navigatorObject, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => Promise.resolve(clipboardWrites.push(text)).then(() => {}),
      },
    })
    cleanups.push(() => {
      if (clipboardDescriptor) {
        Object.defineProperty(navigatorObject, 'clipboard', clipboardDescriptor)
      }
      if (!clipboardDescriptor) {
        delete (navigatorObject as unknown as { clipboard?: Clipboard }).clipboard
      }
    })
    let renderer: FrameRenderer | undefined
    const terminal = await Terminal.create({
      appearance: {
        cursor: { blink: false },
        grid: { columns: 20, rows: 3 },
      },
      rendererFactory: async (options) => {
        const canvas = options.canvas
        if (!(canvas instanceof HTMLCanvasElement)) throw new TypeError('Expected an HTML canvas')
        renderer = new FrameRenderer(canvas, options.onTextFrame, options)
        return renderer
      },
      runtime: { kind: 'borrowed', runtime },
    })
    cleanups.push(() => terminal.dispose())

    await terminal.open(host)
    const data: string[] = []
    terminal.onData((bytes) => data.push(decoder.decode(bytes)))
    terminal.write('copy me')
    terminal.selectAll()
    const apple = /^(Mac|iPhone|iPad|iPod)/iu.test(navigator.platform)
    const copy = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      code: 'KeyC',
      ctrlKey: !apple,
      key: 'c',
      metaKey: apple,
    })
    terminal.textarea!.dispatchEvent(copy)
    await Promise.resolve()

    expect(copy.defaultPrevented).toBe(true)
    expect(clipboardWrites).toEqual(apple ? ['copy me'] : [])
    expect(data).toEqual(apple ? [] : ['\u0003'])

    renderer!.emit(frame(['copy me', '', ''], { x: 7, y: 0 }))
    expect(host.querySelectorAll('[role="listitem"]')).toHaveLength(3)
    const scrollbarElement = host.querySelector<HTMLElement>('[role="scrollbar"]')
    expect(scrollbarElement).not.toBeNull()
    scrollbarElement!.focus()
    expect(terminal.hasPendingTimer).toBe(true)

    terminal.dispose()
    expect(renderer!.disposed).toBe(true)
    expect(terminal.hasPendingFrame).toBe(false)
    expect(terminal.hasPendingTimer).toBe(false)
    expect(host.querySelector('.ghostty-webgpu')).toBeNull()
    expect(host.querySelector('.ghostty-webgpu-link')).toBeNull()
    expect(host.querySelector('.ghostty-webgpu-scrollbar')).toBeNull()
    expect(host.querySelector('.ghostty-webgpu-accessibility')).toBeNull()
  })
})

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { GhosttyRuntime } from '../../core/runtime.js'
import type { TerminalScrollbar } from '../../core/types.js'
import type {
  RendererFrameSnapshot,
  RendererGridSize,
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
    private readonly onFrame: WebGpuTerminalRendererOptions['onFrame'],
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
    this.onFrame?.(snapshot)
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
      renderer = new FrameRenderer(canvas, rendererOptions.onFrame, rendererOptions)
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

describe.sequential('terminal links in Chromium', () => {
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

describe.sequential('terminal clipboard policy in Chromium', () => {
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

describe.sequential('integrated terminal UI host', () => {
  it('replays a renderer frame that arrives before the first fit commit', async () => {
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
        options.onFrame?.(frame([text, '', '', '']))
        renderer = new FrameRenderer(canvas, options.onFrame, options)
        return renderer
      },
      runtime: { kind: 'borrowed', runtime },
    })
    cleanups.push(() => terminal.dispose())

    await terminal.open(host)
    await settleTerminal(terminal)
    moveTerminalPointer(terminal, 5, 0)
    await waitForUi(
      () => host.querySelector('[role="link"]')?.getAttribute('aria-label') === text,
      'Early frame was not replayed after fit committed',
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
        return new FrameRenderer(canvas, options.onFrame, options)
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
        renderer = new FrameRenderer(canvas, options.onFrame, options)
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

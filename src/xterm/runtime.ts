import type { SelectionPoint } from '../core/selection.js'
import type { TerminalElements } from '../dom/elements.js'
import {
  createGhosttyWebGpuTerminalFromSession,
  type Terminal as NativeTerminal,
} from '../dom/terminal.js'
import type { RendererFrameSnapshot, WebGpuTerminalRendererOptions } from '../render/renderer.js'
import { createCompatibleTerminalRenderer } from '../render/selector.js'
import { TerminalSession } from '../term/session.js'
import type { TerminalInputData } from '../term/types.js'
import { applyAllTerminalOptions, applyTerminalOptions, initialAppearance } from './appearance.js'
import { createXtermTerminalElements } from './elements.js'
import type { TerminalOptionKey, TerminalOptionValues } from './options.js'
import type {
  XtermInputHooks,
  XtermPointerHooks,
  XtermRuntimeHandlers,
  XtermTerminalDependencies,
  XtermTerminalHostOpening,
  XtermTerminalRuntime,
} from './runtime-types.js'
import type { IBufferRange, IDisposable, IModes } from './types.js'

const decoder = new TextDecoder()

function compositeDisposable(disposables: readonly IDisposable[]): IDisposable {
  let disposed = false
  return Object.freeze({
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const disposable of [...disposables].reverse()) disposable.dispose()
    },
  })
}

function terminalParent(elements: TerminalElements): HTMLElement {
  const parent = elements.root.parentElement
  if (parent) return parent
  throw new TypeError('Precreated terminal elements must remain attached while opening')
}

function rendererFactory(onFrame: (snapshot: RendererFrameSnapshot) => void) {
  return (options: WebGpuTerminalRendererOptions, _signal: AbortSignal) => {
    const nativeOnFrame = options.onFrame
    return createCompatibleTerminalRenderer({
      ...options,
      onFrame: (snapshot) => {
        nativeOnFrame?.(snapshot)
        onFrame(snapshot)
      },
    })
  }
}

function xtermSelectionRange(
  session: TerminalSession<Event>,
  column: number,
  row: number,
  length: number,
): readonly [SelectionPoint, SelectionPoint] | undefined {
  if (length <= 0) return undefined
  const columns = session.grid.columns
  const maxRow = session.scrollbackLength + session.grid.rows - 1
  const startRow = Math.max(0, Math.min(maxRow, row))
  const startColumn = Math.max(0, Math.min(columns - 1, column))
  const endOffset = startColumn + length - 1
  const projectedEndRow = startRow + Math.floor(endOffset / columns)
  const endRow = Math.max(0, Math.min(maxRow, projectedEndRow))
  const endColumn = projectedEndRow > maxRow ? columns - 1 : endOffset % columns
  return [
    { x: startColumn, y: startRow },
    { x: endColumn, y: endRow },
  ]
}

function exclusiveRange(session: TerminalSession<Event>): IBufferRange | undefined {
  const coordinates = session.selectionCoordinates()
  if (!coordinates) return undefined
  return {
    end: { x: coordinates.end.x + 1, y: coordinates.end.y },
    start: { ...coordinates.start },
  }
}

function runtimeModes(): Readonly<Partial<IModes>> {
  return Object.freeze({})
}

class NativeXtermRuntime implements XtermTerminalRuntime {
  private disposed = false
  private host?: NativeTerminal
  private inactiveCursorStyle: TerminalOptionValues['cursorInactiveStyle']
  readonly modes = runtimeModes()
  private screenReaderMode: boolean

  constructor(
    private readonly session: TerminalSession<Event>,
    values: TerminalOptionValues,
  ) {
    this.inactiveCursorStyle = values.cursorInactiveStyle
    this.screenReaderMode = values.screenReaderMode
  }

  get cursor(): Readonly<{ x: number; y: number }> {
    return this.session.cursor
  }

  applyOptions(values: TerminalOptionValues, keys: readonly TerminalOptionKey[]): void {
    applyTerminalOptions(this.session, values, keys)
    if (keys.includes('wordSeparator')) {
      this.session.setSelectionWordBoundaryCodepoints(values.wordSeparator)
    }
    if (keys.includes('cursorInactiveStyle')) {
      this.inactiveCursorStyle = values.cursorInactiveStyle
      this.host?.setCursorInactiveStyle(this.inactiveCursorStyle)
    }
    if (keys.includes('screenReaderMode')) {
      this.screenReaderMode = values.screenReaderMode
      this.host?.setAccessibilityEnabled(this.screenReaderMode)
    }
  }

  clear(): void {
    this.session.clear()
  }

  clearSelection(): boolean {
    if (this.host) return this.host.clearSelection()
    return this.session.clearSelection()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.session.dispose()
  }

  getSelection(): string | undefined {
    return this.session.getSelection()
  }

  getSelectionPosition(): IBufferRange | undefined {
    return exclusiveRange(this.session)
  }

  hasSelection(): boolean {
    return this.session.selectionCoordinates() !== undefined
  }

  input(data: string, wasUserInput: boolean): void {
    this.session.sendInput(data, { preserveSelection: !wasUserInput })
  }

  open(
    elements: TerminalElements,
    inputHooks: XtermInputHooks,
    pointerHooks: XtermPointerHooks,
    onFrame: (snapshot: RendererFrameSnapshot) => void,
  ): XtermTerminalHostOpening {
    const host = createGhosttyWebGpuTerminalFromSession(this.session, {
      accessibility: this.screenReaderMode ? {} : false,
      autoFit: false,
      elements,
      inputHooks: {
        beforeUserInput: inputHooks.beforeUserInput,
        customKeyEvent: inputHooks.customKeyEvent,
        inputReady: inputHooks.inputReady,
        inputDisabled: inputHooks.inputDisabled,
        macOptionIsMeta: inputHooks.macOptionIsMeta,
        onKey: (event, data) => inputHooks.onKey(decoder.decode(data), event),
        screenReaderMode: inputHooks.screenReaderMode,
      },
      pointerHooks: { customWheelEvent: pointerHooks.customWheelEvent },
      rendererFactory: rendererFactory(onFrame),
    })
    this.host = host
    host.setCursorInactiveStyle(this.inactiveCursorStyle)
    const ready = host.open(terminalParent(elements)).catch((cause: unknown) => {
      if (this.host === host) this.host = undefined
      throw cause
    })
    return { host, ready }
  }

  paste(data: string, ignoreBracketedPasteMode: boolean): void {
    this.session.paste(data, { bracketed: ignoreBracketedPasteMode ? false : undefined })
  }

  reset(): void {
    this.session.reset()
  }

  resize(cols: number, rows: number): void {
    this.session.resize({ columns: cols, rows })
  }

  scrollBy(amount: number): void {
    this.session.scrollBy(amount)
  }

  scrollToBottom(): void {
    this.session.scrollToBottom()
  }

  scrollToLine(line: number): void {
    this.session.scrollToRow(line)
  }

  scrollToTop(): void {
    this.session.scrollToTop()
  }

  select(column: number, row: number, length: number): boolean {
    const range = xtermSelectionRange(this.session, column, row, length)
    if (!range) return this.clearSelection()
    if (this.host) return this.host.selectRange(range[0], range[1])
    return this.session.selectRange(range[0], range[1]).selectionChanged
  }

  selectAll(): boolean {
    if (this.host) return this.host.selectAll()
    return this.session.selectAll().selectionChanged
  }

  selectLines(start: number, end: number): boolean {
    const maxRow = this.session.scrollbackLength + this.session.grid.rows - 1
    const first = Math.max(0, Math.min(maxRow, start))
    const last = Math.max(first, Math.min(maxRow, end))
    if (this.host) return this.host.selectLines(first, last)
    return this.session.selectLines(first, last).selectionChanged
  }

  subscribe(handlers: XtermRuntimeHandlers): IDisposable {
    return compositeDisposable([
      this.session.on('bell', handlers.bell),
      this.session.on('data', ({ bytes }) => handlers.data(Uint8Array.from(bytes))),
      this.session.on('error', ({ cause, operation }) => handlers.error(cause, operation)),
      this.session.on('resize', ({ grid }) => handlers.resize(grid.columns, grid.rows)),
      this.session.on('scroll', ({ scrollbar }) => handlers.scroll(scrollbar.offset)),
      this.session.on('selection', handlers.selection),
      this.session.on('title', ({ title }) => handlers.title(title)),
    ])
  }

  write(data: TerminalInputData): void {
    const focusReportingBefore = this.session.focusReportingEnabled
    this.session.write(data)
    if (focusReportingBefore || !this.session.focusReportingEnabled) return
    this.session.reportFocus()
  }
}

async function createRuntime(
  values: TerminalOptionValues,
  cols: number,
  rows: number,
): Promise<XtermTerminalRuntime> {
  const session = await TerminalSession.create<Event>({
    appearance: initialAppearance(values, cols, rows),
  })
  try {
    applyAllTerminalOptions(session, values)
    return new NativeXtermRuntime(session, values)
  } catch (cause) {
    try {
      session.dispose()
    } catch {}
    throw cause
  }
}

export const defaultXtermTerminalDependencies: XtermTerminalDependencies = Object.freeze({
  createElements: createXtermTerminalElements,
  createRuntime,
})

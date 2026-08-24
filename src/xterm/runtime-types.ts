import type { TerminalElements } from '../dom/elements.js'
import type { TerminalInputData } from '../term/types.js'
import type { RendererFrameSnapshot } from '../render/renderer.js'
import type { IBufferRange, IDisposable, IModes } from './types.js'
import type { TerminalOptionKey, TerminalOptionValues } from './options.js'

export interface XtermRuntimeHandlers {
  readonly bell: () => void
  readonly data: (data: Uint8Array) => void
  readonly error: (cause: unknown, operation: string) => void
  readonly resize: (cols: number, rows: number) => void
  readonly scroll: (position: number) => void
  readonly selection: () => void
  readonly title: (title: string) => void
}

export interface XtermInputHooks {
  readonly beforeUserInput: () => void
  readonly customKeyEvent: (event: KeyboardEvent) => boolean
  readonly inputDisabled: () => boolean
  readonly onKey: (key: string, event: KeyboardEvent) => void
}

export interface XtermPointerHooks {
  readonly customWheelEvent: (event: WheelEvent) => boolean
}

export interface XtermTerminalHost extends IDisposable {
  blur(): void
  clearTextureAtlas(): void
  focus(): void
  refresh(start: number, end: number): void
}

export interface XtermTerminalHostOpening {
  readonly host: XtermTerminalHost
  readonly ready: Promise<void>
}

export interface XtermTerminalRuntime extends IDisposable {
  readonly cursor: Readonly<{ x: number; y: number }>
  readonly modes: Readonly<Partial<IModes>>

  applyOptions(values: TerminalOptionValues, keys: readonly TerminalOptionKey[]): void
  clear(): void
  clearSelection(): boolean
  getSelection(): string | undefined
  getSelectionPosition(): IBufferRange | undefined
  hasSelection(): boolean
  input(data: string, wasUserInput: boolean): void
  open(
    elements: TerminalElements,
    inputHooks: XtermInputHooks,
    pointerHooks: XtermPointerHooks,
    onFrame: (snapshot: RendererFrameSnapshot) => void,
  ): XtermTerminalHostOpening
  paste(data: string, ignoreBracketedPasteMode: boolean): void
  reset(): void
  resize(cols: number, rows: number): void
  scrollBy(amount: number): void
  scrollToBottom(): void
  scrollToLine(line: number): void
  scrollToTop(): void
  select(column: number, row: number, length: number): void
  selectAll(): void
  selectLines(start: number, end: number): void
  subscribe(handlers: XtermRuntimeHandlers): IDisposable
  write(data: TerminalInputData): void
}

export interface XtermTerminalDependencies {
  readonly createElements: (parent: HTMLElement) => TerminalElements
  readonly createRuntime: (
    values: TerminalOptionValues,
    cols: number,
    rows: number,
  ) => Promise<XtermTerminalRuntime>
  readonly scheduleWriteParsed: (callback: () => void) => void
}

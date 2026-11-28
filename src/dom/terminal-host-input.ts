import { createGhosttyError } from '../core/error.js'
import type { RendererTextFrameSnapshot } from '../render/shared/types.js'
import type { TerminalFittedFont, TerminalInputData, TerminalRendererTheme } from '../term/types.js'
import type { WorkerTerminalExecution } from '../worker/execution.js'
import { writeUserSelectionToClipboard } from './clipboard.js'
import type { TerminalElements } from './elements.js'
import type { LocalTerminalExecution } from './execution-local.js'
import {
  createDomInputController,
  createDomInputLifecycleController,
  type DomInputController,
} from './input.js'
import type { GhosttyWebGpuTerminalFromSessionOptions } from './types.js'

function leadingCursorColumn(snapshot: RendererTextFrameSnapshot): number | undefined {
  const viewport = snapshot.cursor.viewport
  if (!viewport) return undefined
  if (!viewport.wideTail) return viewport.x
  return Math.max(0, viewport.x - 1)
}

function cssRgb(color: TerminalRendererTheme['foreground']): string {
  return `rgb(${color.r} ${color.g} ${color.b})`
}

function applyPreeditAppearance(
  element: HTMLElement,
  font: TerminalFittedFont,
  theme: TerminalRendererTheme,
): void {
  element.style.backgroundColor = cssRgb(theme.background)
  element.style.color = cssRgb(theme.foreground)
  element.style.fontFamily = font.settings.family
  element.style.fontSize = `${font.settings.size}px`
  element.style.fontWeight = `${font.settings.weight}`
  element.style.letterSpacing = `${font.settings.letterSpacing}px`
  element.style.lineHeight = `${font.cssCellHeight}px`
  element.style.minHeight = `${font.cssCellHeight}px`
  element.style.minWidth = `${font.cssCellWidth}px`
}

type HostInputOptions = Pick<
  GhosttyWebGpuTerminalFromSessionOptions,
  'copySelection' | 'inputHooks' | 'keyboard'
>

interface InputSource {
  readonly execution: LocalTerminalExecution | WorkerTerminalExecution
  claimKey(event: KeyboardEvent): boolean
  claimText(type: 'paste' | 'text' | 'composition', data: TerminalInputData): boolean
  elements(): TerminalElements | undefined
  font(): TerminalFittedFont | undefined
  isPresent(): boolean
  lastFrame(): RendererTextFrameSnapshot | undefined
  noteInput(): void
  onError(cause: unknown, operation: string): void
  setDocumentVisible(visible: boolean): void
  setFocused(focused: boolean): void
  setReducedMotion(reduced: boolean): void
}

export class TerminalHostInput {
  private input?: DomInputController
  private preeditActive = false
  private inputFocused = false
  private compositionActive = false

  constructor(
    private readonly options: HostInputOptions,
    private readonly source: InputSource,
  ) {}

  resetTransientState(): void {
    this.input?.resetTransientState()
  }

  positionAtLastFrame(operation: string): void {
    const snapshot = this.source.lastFrame()
    if (!snapshot) return
    try {
      this.positionTextarea(snapshot)
    } catch (cause) {
      this.source.onError(cause, operation)
    }
  }

  attach(elements: TerminalElements, addCleanup: (cleanup: () => void) => void): void {
    let input: DomInputController | undefined
    if (this.options.keyboard !== false) {
      const view = elements.root.ownerDocument.defaultView
      if (!view) throw createGhosttyError('input.install', 'Terminal input requires a window')
      elements.textarea.addEventListener('focus', this.handleTextareaFocus, {
        signal: elements.signal,
      })
      elements.textarea.addEventListener('blur', this.handleTextareaBlur, {
        signal: elements.signal,
      })
      elements.textarea.addEventListener('compositionstart', this.handleCompositionStart, {
        signal: elements.signal,
      })
      elements.textarea.addEventListener('compositionend', this.handleCompositionEnd, {
        signal: elements.signal,
      })
      input = createDomInputController({
        claimKey: this.source.claimKey,
        claimText: this.source.claimText,
        hooks: {
          ...this.options.inputHooks,
          beforeUserInput: () => {
            this.source.noteInput()
            this.options.inputHooks?.beforeUserInput?.()
          },
        },
        onError: (cause, operation) => this.source.onError(cause, `input.${operation}`),
        onPreedit: (value) => this.updatePreedit(value),
        selectionReadback: {
          hasSelection: () =>
            this.source.execution.kind === 'sync'
              ? this.source.execution.selectionCoordinates() !== undefined
              : this.source.execution.submittedFrame?.selection !== undefined,
          copy: () => this.copyUserSelection(view, elements.signal),
        },
        ...(this.source.execution.kind === 'sync'
          ? { session: this.source.execution.input }
          : { encoding: this.source.execution }),
        signal: elements.signal,
        textarea: elements.textarea,
      })
      this.input = input
      addCleanup(() => {
        try {
          input?.dispose()
        } finally {
          this.input = undefined
          this.preeditActive = false
        }
      })
    }
    const motion = elements.root.ownerDocument.defaultView?.matchMedia(
      '(prefers-reduced-motion: reduce)',
    )
    const updateMotion = () => {
      const reduced = motion?.matches ?? false
      if (this.source.execution.kind === 'async') {
        void this.source.execution
          .request('reducedMotion', [reduced])
          .catch((cause: unknown) => this.source.onError(cause, 'motion'))
        return
      }
      this.source.setReducedMotion(reduced)
    }
    motion?.addEventListener('change', updateMotion, { signal: elements.signal })
    updateMotion()
    const lifecycle = createDomInputLifecycleController({
      onDocumentVisible: (visible) => this.source.setDocumentVisible(visible),
      onError: (cause, operation) => this.source.onError(cause, `input.${operation}`),
      onFocused: (focused) => this.source.setFocused(focused),
      onResetTransientState: () => input?.resetTransientState(),
      session: this.source.execution.focus,
      signal: elements.signal,
      textarea: elements.textarea,
    })
    addCleanup(() => lifecycle.dispose())
    this.options.inputHooks?.inputReady?.()
  }

  private async copyUserSelection(view: Window, signal: AbortSignal): Promise<void> {
    const text =
      this.source.execution.kind === 'sync'
        ? this.source.execution.getSelection()
        : this.source.execution.selectionSnapshot().then((snapshot) => snapshot.selection?.text)
    if (text === undefined) return
    const copy = this.options.copySelection
    if (!copy) return writeUserSelectionToClipboard(view, text, { signal })
    const value = typeof text === 'string' ? text : await text
    signal.throwIfAborted()
    if (value !== undefined) await copy(value)
  }

  private readonly handleTextareaFocus = (): void => {
    this.inputFocused = true
    this.positionAtLastFrame('focus.caret')
  }

  private readonly handleTextareaBlur = (): void => {
    this.inputFocused = false
  }

  private readonly handleCompositionStart = (): void => {
    this.compositionActive = true
    this.positionAtLastFrame('composition.caret')
  }

  private readonly handleCompositionEnd = (): void => {
    this.compositionActive = false
  }

  positionTextarea(snapshot: RendererTextFrameSnapshot): void {
    const elements = this.source.elements()
    if (!elements) return
    if (!this.inputFocused && !this.compositionActive) return
    if (!this.source.isPresent()) return
    const column = leadingCursorColumn(snapshot)
    const viewport = snapshot.cursor.viewport
    if (column === undefined || !viewport) return
    const summary = this.source.execution.submittedFrame
    if (!summary) return
    const grid = summary.grid
    elements.positionTextarea({
      x: summary.padding.left + column * grid.cellWidth,
      y: summary.padding.top + viewport.y * grid.cellHeight,
    })
  }

  private updatePreedit(value: string): void {
    this.preeditActive = value.length > 0
    const compositionView = this.source.elements()?.compositionView
    if (!compositionView) return
    if (this.preeditActive) {
      const summary = this.source.execution.submittedFrame
      const appearance = this.source.execution.appearance
      const font = summary?.font ?? this.source.font()
      this.updatePreeditAppearance(font, summary?.theme ?? appearance.rendererTheme)
    }
    compositionView.textContent = value
    compositionView.classList.toggle('active', this.preeditActive)
    compositionView.hidden = !this.preeditActive
  }

  updatePreeditAppearance(
    font: TerminalFittedFont | undefined,
    theme: TerminalRendererTheme,
  ): void {
    if (!this.preeditActive || !font) return
    const compositionView = this.source.elements()?.compositionView
    if (!compositionView) return
    applyPreeditAppearance(compositionView, font, theme)
  }
}

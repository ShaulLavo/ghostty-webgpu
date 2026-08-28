export interface TerminalElementPadding {
  readonly bottom: number
  readonly left: number
  readonly right: number
  readonly top: number
}

export type TerminalElementPaddingInput = number | Partial<TerminalElementPadding>

export interface TerminalCaretPosition {
  readonly x: number
  readonly y: number
}

export interface TerminalElementsOptions {
  readonly padding?: TerminalElementPaddingInput
}

export interface TerminalElements {
  readonly canvas: HTMLCanvasElement
  readonly compositionView?: HTMLDivElement
  readonly padding: TerminalElementPadding
  readonly root: HTMLDivElement
  readonly signal: AbortSignal
  readonly textarea: HTMLTextAreaElement

  dispose(): void
  positionTextarea(position: TerminalCaretPosition): void
  setPadding(padding: TerminalElementPaddingInput): boolean
}

const zeroPadding: TerminalElementPadding = Object.freeze({
  bottom: 0,
  left: 0,
  right: 0,
  top: 0,
})

function nonNegativeFinite(name: string, value: number): number {
  if (Number.isFinite(value) && value >= 0) return value === 0 ? 0 : value
  throw new RangeError(`${name} must be a finite non-negative number`)
}

export function normalizeTerminalElementPadding(
  input: TerminalElementPaddingInput | undefined,
): TerminalElementPadding {
  if (input === undefined) return zeroPadding
  if (typeof input === 'number') {
    const value = nonNegativeFinite('padding', input)
    return Object.freeze({ bottom: value, left: value, right: value, top: value })
  }
  return Object.freeze({
    bottom: nonNegativeFinite('padding.bottom', input.bottom ?? 0),
    left: nonNegativeFinite('padding.left', input.left ?? 0),
    right: nonNegativeFinite('padding.right', input.right ?? 0),
    top: nonNegativeFinite('padding.top', input.top ?? 0),
  })
}

function paddingEquals(left: TerminalElementPadding, right: TerminalElementPadding): boolean {
  return (
    left.bottom === right.bottom &&
    left.left === right.left &&
    left.right === right.right &&
    left.top === right.top
  )
}

function applyRootStyles(root: HTMLDivElement): void {
  root.style.height = '100%'
  root.style.overflow = 'hidden'
  root.style.position = 'relative'
  root.style.width = '100%'
}

function applyCanvasStyles(canvas: HTMLCanvasElement, padding: TerminalElementPadding): void {
  canvas.style.boxSizing = 'content-box'
  canvas.style.display = 'block'
  canvas.style.paddingBottom = `${padding.bottom}px`
  canvas.style.paddingLeft = `${padding.left}px`
  canvas.style.paddingRight = `${padding.right}px`
  canvas.style.paddingTop = `${padding.top}px`
}

function disableTextAssistance(textarea: HTMLTextAreaElement): void {
  textarea.autocomplete = 'off'
  textarea.setAttribute('autocapitalize', 'off')
  textarea.setAttribute('autocorrect', 'off')
  textarea.spellcheck = false
  textarea.wrap = 'off'
}

function applyTextareaStyles(textarea: HTMLTextAreaElement): void {
  textarea.style.background = 'transparent'
  textarea.style.border = '0'
  textarea.style.caretColor = 'transparent'
  textarea.style.color = 'transparent'
  textarea.style.height = '1px'
  textarea.style.left = '0'
  textarea.style.margin = '0'
  textarea.style.opacity = '0'
  textarea.style.outline = 'none'
  textarea.style.overflow = 'hidden'
  textarea.style.padding = '0'
  textarea.style.pointerEvents = 'none'
  textarea.style.position = 'absolute'
  textarea.style.resize = 'none'
  textarea.style.top = '0'
  textarea.style.whiteSpace = 'pre'
  textarea.style.width = '1px'
}

function applyCompositionStyles(compositionView: HTMLDivElement): void {
  compositionView.hidden = true
  compositionView.style.boxSizing = 'content-box'
  compositionView.style.left = '0'
  compositionView.style.margin = '0'
  compositionView.style.overflow = 'visible'
  compositionView.style.padding = '0'
  compositionView.style.pointerEvents = 'none'
  compositionView.style.position = 'absolute'
  compositionView.style.textDecoration = 'underline'
  compositionView.style.top = '0'
  compositionView.style.whiteSpace = 'pre'
  compositionView.style.zIndex = '1'
}

function finitePosition(name: string, value: number): number {
  if (Number.isFinite(value)) return Math.max(0, value)
  throw new RangeError(`${name} must be finite`)
}

class OwnedTerminalElements implements TerminalElements {
  private committedPadding: TerminalElementPadding
  private disposed = false

  constructor(
    readonly root: HTMLDivElement,
    readonly canvas: HTMLCanvasElement,
    readonly textarea: HTMLTextAreaElement,
    readonly compositionView: HTMLDivElement,
    padding: TerminalElementPadding,
    private readonly abortController: AbortController,
  ) {
    this.committedPadding = padding
  }

  get padding(): TerminalElementPadding {
    return this.committedPadding
  }

  get signal(): AbortSignal {
    return this.abortController.signal
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.abortController.abort()
    this.root.remove()
  }

  positionTextarea(position: TerminalCaretPosition): void {
    if (this.disposed) return
    const x = finitePosition('caret x', position.x)
    const y = finitePosition('caret y', position.y)
    this.textarea.style.left = `${x}px`
    this.textarea.style.top = `${y}px`
    this.compositionView.style.left = `${x}px`
    this.compositionView.style.top = `${y}px`
  }

  setPadding(input: TerminalElementPaddingInput): boolean {
    if (this.disposed) return false
    const padding = normalizeTerminalElementPadding(input)
    if (paddingEquals(this.committedPadding, padding)) return false
    applyCanvasStyles(this.canvas, padding)
    this.committedPadding = padding
    return true
  }
}

export function createTerminalElements(
  parent: HTMLElement,
  options: TerminalElementsOptions = {},
): TerminalElements {
  const padding = normalizeTerminalElementPadding(options.padding)
  const document = parent.ownerDocument
  const root = document.createElement('div')
  const canvas = document.createElement('canvas')
  const textarea = document.createElement('textarea')
  const compositionView = document.createElement('div')
  const abortController = new AbortController()

  root.className = 'ghostty-webgpu'
  canvas.className = 'ghostty-webgpu-canvas'
  textarea.className = 'ghostty-webgpu-input'
  compositionView.className = 'ghostty-webgpu-composition'
  compositionView.setAttribute('aria-hidden', 'true')
  textarea.setAttribute('aria-label', 'Terminal input')
  textarea.tabIndex = 0

  applyRootStyles(root)
  applyCanvasStyles(canvas, padding)
  disableTextAssistance(textarea)
  applyTextareaStyles(textarea)
  applyCompositionStyles(compositionView)

  root.append(canvas, compositionView, textarea)
  parent.append(root)
  return new OwnedTerminalElements(
    root,
    canvas,
    textarea,
    compositionView,
    padding,
    abortController,
  )
}

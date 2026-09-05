import {
  normalizeTerminalElementPadding,
  replaceTerminalCanvas,
  type TerminalCaretPosition,
  type TerminalElementPadding,
  type TerminalElementPaddingInput,
  type TerminalElements,
  type TerminalElementsOptions,
} from '../dom/elements.js'

export interface XtermTerminalElements extends TerminalElements {
  readonly compositionView: HTMLDivElement
  readonly decorationContainer: HTMLDivElement
  readonly helperContainer: HTMLDivElement
  readonly screen: HTMLDivElement
  readonly scrollable: HTMLDivElement
  readonly selectionContainer: HTMLDivElement
  readonly viewport: HTMLDivElement
}

function nonNegativePosition(name: string, value: number): number {
  if (Number.isFinite(value)) return Math.max(0, value)
  throw new RangeError(`${name} must be finite`)
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
  textarea.setAttribute('autocapitalize', 'off')
  textarea.setAttribute('autocorrect', 'off')
  textarea.spellcheck = false
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
  textarea.style.whiteSpace = 'nowrap'
  textarea.style.width = '1px'
}

function applyCompositionStyles(compositionView: HTMLDivElement): void {
  compositionView.style.left = '0'
  compositionView.style.top = '0'
}

class OwnedXtermTerminalElements implements XtermTerminalElements {
  private committedPadding: TerminalElementPadding
  private disposed = false

  constructor(
    readonly root: HTMLDivElement,
    private canvasValue: HTMLCanvasElement,
    readonly textarea: HTMLTextAreaElement,
    readonly viewport: HTMLDivElement,
    readonly scrollable: HTMLDivElement,
    readonly screen: HTMLDivElement,
    readonly helperContainer: HTMLDivElement,
    readonly compositionView: HTMLDivElement,
    readonly selectionContainer: HTMLDivElement,
    readonly decorationContainer: HTMLDivElement,
    padding: TerminalElementPadding,
    private readonly abortController: AbortController,
  ) {
    this.committedPadding = padding
  }

  get canvas(): HTMLCanvasElement {
    return this.canvasValue
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
    const x = nonNegativePosition('caret x', position.x)
    const y = nonNegativePosition('caret y', position.y)
    this.textarea.style.left = `${x}px`
    this.textarea.style.top = `${y}px`
    this.compositionView.style.left = `${x}px`
    this.compositionView.style.top = `${y}px`
  }

  replaceCanvas(): HTMLCanvasElement {
    if (this.disposed) throw new Error('Terminal elements have been disposed')
    this.canvasValue = replaceTerminalCanvas(this.canvasValue)
    return this.canvasValue
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

function installFocusClasses(elements: XtermTerminalElements): void {
  elements.textarea.addEventListener('focus', () => elements.root.classList.add('focus'), {
    signal: elements.signal,
  })
  elements.textarea.addEventListener('blur', () => elements.root.classList.remove('focus'), {
    signal: elements.signal,
  })
}

function installCompositionView(elements: XtermTerminalElements): void {
  elements.textarea.addEventListener(
    'compositionstart',
    () => {
      elements.compositionView.textContent = ''
      elements.compositionView.classList.add('active')
    },
    { signal: elements.signal },
  )
  elements.textarea.addEventListener(
    'compositionupdate',
    (event) => {
      elements.compositionView.textContent = event.data
    },
    { signal: elements.signal },
  )
  elements.textarea.addEventListener(
    'compositionend',
    () => {
      elements.compositionView.classList.remove('active')
    },
    { signal: elements.signal },
  )
}

function buildElements(
  parent: HTMLElement,
  padding: TerminalElementPadding,
  abortController: AbortController,
): XtermTerminalElements {
  const document = parent.ownerDocument
  const root = document.createElement('div')
  const viewport = document.createElement('div')
  const scrollable = document.createElement('div')
  const screen = document.createElement('div')
  const helperContainer = document.createElement('div')
  const textarea = document.createElement('textarea')
  const compositionView = document.createElement('div')
  const canvas = document.createElement('canvas')
  const selectionContainer = document.createElement('div')
  const decorationContainer = document.createElement('div')

  root.className = 'terminal xterm ghostty-webgpu'
  root.dir = 'ltr'
  viewport.className = 'xterm-viewport'
  scrollable.className = 'xterm-scrollable-element'
  scrollable.setAttribute('role', 'presentation')
  scrollable.style.position = 'relative'
  screen.className = 'xterm-screen'
  helperContainer.className = 'xterm-helpers'
  textarea.className = 'xterm-helper-textarea ghostty-webgpu-input'
  compositionView.className = 'composition-view'
  canvas.className = 'ghostty-webgpu-canvas'
  selectionContainer.className = 'xterm-selection'
  selectionContainer.setAttribute('aria-hidden', 'true')
  decorationContainer.className = 'xterm-decoration-container'
  textarea.setAttribute('aria-label', 'Terminal input')
  textarea.setAttribute('aria-multiline', 'false')
  textarea.tabIndex = 0

  applyRootStyles(root)
  applyCanvasStyles(canvas, padding)
  disableTextAssistance(textarea)
  applyTextareaStyles(textarea)
  applyCompositionStyles(compositionView)

  helperContainer.append(textarea, compositionView)
  screen.append(helperContainer, canvas, selectionContainer, decorationContainer)
  scrollable.append(screen)
  root.append(viewport, scrollable)
  parent.append(root)

  return new OwnedXtermTerminalElements(
    root,
    canvas,
    textarea,
    viewport,
    scrollable,
    screen,
    helperContainer,
    compositionView,
    selectionContainer,
    decorationContainer,
    padding,
    abortController,
  )
}

export function createXtermTerminalElements(
  parent: HTMLElement,
  options: TerminalElementsOptions = {},
): XtermTerminalElements {
  const padding = normalizeTerminalElementPadding(options.padding)
  const elements = buildElements(parent, padding, new AbortController())
  installFocusClasses(elements)
  installCompositionView(elements)
  return elements
}

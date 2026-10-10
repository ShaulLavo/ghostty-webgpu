import type { ReadRowsOptions, RenderRow } from '../../core/types.js'
import type { TerminalFittedFont } from '../../term/types.js'
import {
  canonicalRendererTheme,
  copyFittedFont,
  mergeRendererTheme,
  normalizeRendererGrid,
} from '../config.js'
import type { CanonicalRendererTheme, CursorState } from '../instances/types.js'
import type { RendererGridSize, WebGpuTerminalRendererOptions } from '../renderer.js'
import {
  RowTerminalRenderer,
  type RowRendererSurface,
  type RowThemeInvalidation,
} from '../row-renderer.js'
import {
  defaultRowStyle,
  frameStyle,
  renderFrameToHtml,
  renderRowRuns,
  type DefaultRowStyle,
  type RowRun,
} from './html.js'

export { renderFrameToHtml } from './html.js'
export type { RenderFrameHtmlOptions } from './html.js'

function copyTheme(theme: CanonicalRendererTheme): CanonicalRendererTheme {
  // Hosts can mutate and reapply RGB inputs; cached styles need an owned comparison snapshot.
  return {
    ...theme,
    background: { ...theme.background },
    cursor: { ...theme.cursor },
    cursorText: { ...theme.cursorText },
    foreground: { ...theme.foreground },
    selectionBackground: { ...theme.selectionBackground },
    selectionForeground: { ...theme.selectionForeground },
  }
}

function themesEqual(first: CanonicalRendererTheme, second: CanonicalRendererTheme): boolean {
  if (first.minimumContrast !== second.minimumContrast) return false
  const colors = [
    'background',
    'cursor',
    'cursorText',
    'foreground',
    'selectionBackground',
    'selectionForeground',
  ] as const
  return colors.every((key) => {
    const left = first[key]
    const right = second[key]
    return left.r === right.r && left.g === right.g && left.b === right.b
  })
}

interface MountedRun {
  readonly element: HTMLSpanElement
  readonly text: Text
  value: RowRun
}

interface MountedRow {
  readonly element: Element
  readonly runs: MountedRun[]
}

class DomSurface implements RowRendererSurface {
  private readonly container: HTMLDivElement
  private readonly canvas: HTMLCanvasElement
  private canvasStyle: CSSStyleDeclaration
  private styleDocument: Document
  private readonly previousOpacity: string
  private font: TerminalFittedFont
  private grid: RendererGridSize
  private theme: CanonicalRendererTheme
  private rows: MountedRow[] = []
  private defaultStyle: DefaultRowStyle

  constructor(options: WebGpuTerminalRendererOptions) {
    if (!('ownerDocument' in options.canvas) || !options.canvas.parentElement) {
      throw new TypeError('The DOM renderer requires a canvas mounted in a terminal host')
    }
    this.canvas = options.canvas
    this.styleDocument = this.canvas.ownerDocument
    this.canvasStyle = this.styleDocument.defaultView!.getComputedStyle(this.canvas)
    this.font = copyFittedFont(options.font)
    this.grid = normalizeRendererGrid(options)
    this.theme = copyTheme(canonicalRendererTheme(mergeRendererTheme(options.theme)))
    this.defaultStyle = defaultRowStyle(this.font, this.theme, this.grid.columns)
    this.container = this.canvas.ownerDocument.createElement('div')
    this.container.style.position = 'absolute'
    this.container.style.pointerEvents = 'none'
    this.previousOpacity = this.canvas.style.opacity
    this.resize(this.font, this.grid)
    // Transparency preserves the canvas as the terminal pointer target.
    this.canvas.style.opacity = '0'
    this.canvas.after(this.container)
  }

  dispose(): void {
    this.container.remove()
    this.rows = []
    this.canvas.style.opacity = this.previousOpacity
  }

  beginFrame(): void {
    this.position()
  }

  paint(row: RenderRow, cursor: CursorState | undefined): boolean {
    const mounted = this.rows[row.y]
    if (!mounted) return false
    let changed = false
    const runs = renderRowRuns(row, cursor, this.font, this.theme, this.defaultStyle)
    for (let index = 0; index < runs.length; index += 1) {
      const run = runs[index]!
      const previous = mounted.runs[index]
      if (!previous) {
        const element = this.canvas.ownerDocument.createElement('span')
        const text = this.canvas.ownerDocument.createTextNode(run.text)
        if (run.cursor) element.setAttribute('data-cursor', run.cursor)
        element.setAttribute('style', run.style)
        element.append(text)
        mounted.element.append(element)
        mounted.runs.push({ element, text, value: run })
        changed = true
        continue
      }
      if (previous.value.style !== run.style) {
        previous.element.setAttribute('style', run.style)
        changed = true
      }
      if (previous.value.text !== run.text) {
        previous.text.data = run.text
        changed = true
      }
      if (previous.value.cursor !== run.cursor) {
        if (run.cursor) previous.element.setAttribute('data-cursor', run.cursor)
        else previous.element.removeAttribute('data-cursor')
        changed = true
      }
      previous.value = run
    }
    while (mounted.runs.length > runs.length) {
      mounted.runs.pop()!.element.remove()
      changed = true
    }
    return changed
  }

  resize(font: TerminalFittedFont, grid: RendererGridSize): void {
    const cursor = {
      blinking: false,
      passwordInput: false,
      style: 'block' as const,
      visible: false,
    }
    // Validate serialized CSS before changing the canvas geometry or mounting the surface.
    const html = renderFrameToHtml({ cursor, rows: [] }, { ...grid, font, theme: this.theme })
    this.font = font
    this.grid = grid
    this.defaultStyle = defaultRowStyle(font, this.theme, grid.columns)
    this.canvas.width = grid.columns * font.deviceCellWidth
    this.canvas.height = grid.rows * font.deviceCellHeight
    this.canvas.style.width = `${grid.columns * font.cssCellWidth}px`
    this.canvas.style.height = `${grid.rows * font.cssCellHeight}px`
    this.container.innerHTML = html
    this.rows = Array.from(this.container.firstElementChild!.children, (element) => ({
      element,
      runs: [],
    }))
    this.position()
  }

  setTheme(theme: CanonicalRendererTheme): RowThemeInvalidation {
    if (themesEqual(this.theme, theme)) return 'cursor'
    this.theme = copyTheme(theme)
    this.defaultStyle = defaultRowStyle(this.font, this.theme, this.grid.columns)
    this.container.firstElementChild?.setAttribute(
      'style',
      frameStyle(this.font, this.grid, this.theme),
    )
    return 'all'
  }

  private position(): void {
    const document = this.canvas.ownerDocument
    if (this.styleDocument !== document) {
      this.canvasStyle = document.defaultView!.getComputedStyle(this.canvas)
      this.styleDocument = document
    }
    // The declaration stays live; flow offsets and padding are read for every frame.
    const style = this.canvasStyle
    const left = this.canvas.offsetLeft + (parseFloat(style.paddingLeft) || 0)
    const top = this.canvas.offsetTop + (parseFloat(style.paddingTop) || 0)
    const declarations = this.container.style
    const leftDeclaration = `${left}px`
    const topDeclaration = `${top}px`
    if (declarations.left !== leftDeclaration || declarations.getPropertyPriority('left') !== '')
      declarations.left = leftDeclaration
    if (declarations.top !== topDeclaration || declarations.getPropertyPriority('top') !== '')
      declarations.top = topDeclaration
  }
}

export class DomTerminalRenderer extends RowTerminalRenderer {
  readonly backend = 'dom' as const

  private constructor(options: WebGpuTerminalRendererOptions) {
    super(options, new DomSurface(options))
  }

  protected override readRows(options: ReadRowsOptions = {}): readonly RenderRow[] {
    return super.readRows({ ...options, packed: true })
  }

  static create(options: WebGpuTerminalRendererOptions): Promise<DomTerminalRenderer> {
    return Promise.resolve(new DomTerminalRenderer(options))
  }
}

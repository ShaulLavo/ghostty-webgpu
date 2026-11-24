import type { RowBidiMapper } from '../../bidi/row.js'
import { loadBidiMapper } from '../../bidi/loader.js'
import type { ReadRowsOptions, RenderRow } from '../../core/types.js'
import type { TerminalFittedFont } from '../../term/types.js'
import {
  canonicalRendererTheme,
  copyFittedFont,
  currentAnimationFrameTime,
  mergeRendererTheme,
  normalizeRendererGrid,
} from '../shared/config.js'
import type { CanonicalRendererTheme, CursorState } from '../shared/instances/types.js'
import type { RendererGridSize, WebGpuTerminalRendererOptions } from '../shared/types.js'
import {
  RowTerminalRenderer,
  type RowRendererSurface,
  type RowThemeInvalidation,
} from '../shared/row-renderer.js'
import {
  defaultRowStyle,
  frameStyle,
  renderFrameToHtml,
  renderRowRuns,
  type DefaultRowStyle,
  type RowRun,
} from './html.js'
import type { LigatureFinder } from '../shared/ligatures/finder.js'

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
  readonly paintsCanvas = false
  private readonly container: HTMLDivElement
  private readonly bidi: boolean
  private readonly canvas: HTMLCanvasElement
  private canvasStyle: CSSStyleDeclaration
  private styleDocument: Document
  private readonly previousOpacity: string
  private font: TerminalFittedFont
  private grid: RendererGridSize
  private theme: CanonicalRendererTheme
  private rows: MountedRow[] = []
  private measuredLeft = 0
  private measuredTop = 0
  private defaultStyle: DefaultRowStyle
  private readonly ligatures?: LigatureFinder

  constructor(options: WebGpuTerminalRendererOptions) {
    this.ligatures = options.ligatures
    if (!('ownerDocument' in options.canvas) || !options.canvas.parentElement) {
      throw new TypeError('The DOM renderer requires a canvas mounted in a terminal host')
    }
    this.bidi = options.bidi ?? false
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
    overlayLayout.add(this)
  }

  dispose(): void {
    overlayLayout.delete(this)
    this.container.remove()
    this.rows = []
    this.canvas.style.opacity = this.previousOpacity
  }

  beginFrame(): void {
    overlayLayout.position(this)
  }

  paint(
    row: RenderRow,
    cursor: CursorState | undefined,
    textVisible: boolean,
    _blinking?: boolean,
    joinCursor?: CursorState,
  ): boolean {
    const mounted = this.rows[row.y]
    if (!mounted) return false
    let changed = false
    const ligatures = this.ligatures ? { finder: this.ligatures, cursor: joinCursor } : undefined
    const runs = renderRowRuns(
      row,
      cursor,
      this.font,
      this.theme,
      this.defaultStyle,
      textVisible,
      this.bidi,
      ligatures,
    )
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

  /** Reads the canvas content origin; touches layout but writes nothing. */
  measure(): void {
    const document = this.canvas.ownerDocument
    if (this.styleDocument !== document) {
      this.canvasStyle = document.defaultView!.getComputedStyle(this.canvas)
      this.styleDocument = document
    }
    // The declaration stays live; flow offsets and padding are read for every frame.
    const style = this.canvasStyle
    this.measuredLeft = this.canvas.offsetLeft + (parseFloat(style.paddingLeft) || 0)
    this.measuredTop = this.canvas.offsetTop + (parseFloat(style.paddingTop) || 0)
  }

  /** Moves the overlay to the last measured origin; writes only changed declarations. */
  place(): void {
    const declarations = this.container.style
    const leftDeclaration = `${this.measuredLeft}px`
    const topDeclaration = `${this.measuredTop}px`
    if (declarations.left !== leftDeclaration || declarations.getPropertyPriority('left') !== '')
      declarations.left = leftDeclaration
    if (declarations.top !== topDeclaration || declarations.getPropertyPriority('top') !== '')
      declarations.top = topDeclaration
  }

  private position(): void {
    this.measure()
    this.place()
  }
}

// The first paint of a display frame measures every overlay before any row write, so peers never force
// a layout each; layout changes made later in that frame are applied by a check on the next frame.
class OverlayLayoutBatch {
  private readonly surfaces = new Set<DomSurface>()
  private readonly measuredAt = new WeakMap<DomSurface, number>()
  private frameTime?: number
  private checkHandle?: number

  add(surface: DomSurface): void {
    this.surfaces.add(surface)
  }

  delete(surface: DomSurface): void {
    this.surfaces.delete(surface)
  }

  position(surface: DomSurface): void {
    const time = currentAnimationFrameTime()
    if (time === undefined) {
      surface.measure()
      surface.place()
      return
    }
    // The paint that starts a batch reads its own geometry fresh; only later paints can miss changes.
    if (this.frameTime !== time) return this.run(time)
    this.scheduleCheck()
    if (this.measuredAt.get(surface) === time) return
    // Joined after this frame's batch (created or moved mid-frame); measure it alone.
    surface.measure()
    surface.place()
  }

  private run(time: number): void {
    this.frameTime = time
    const surfaces = Array.from(this.surfaces)
    for (const surface of surfaces) surface.measure()
    for (const surface of surfaces) {
      surface.place()
      this.measuredAt.set(surface, time)
    }
  }

  private scheduleCheck(): void {
    if (this.checkHandle !== undefined) return
    this.checkHandle = window.requestAnimationFrame((time) => {
      this.checkHandle = undefined
      if (this.frameTime === time || this.surfaces.size === 0) return
      this.run(time)
    })
  }
}

const overlayLayout = new OverlayLayoutBatch()

export class DomTerminalRenderer extends RowTerminalRenderer {
  readonly backend = 'dom' as const

  private constructor(options: WebGpuTerminalRendererOptions, bidi?: RowBidiMapper) {
    super(options, new DomSurface(options), bidi)
  }

  protected override readRows(options: ReadRowsOptions = {}): readonly RenderRow[] {
    return super.readRows({ ...options, packed: true })
  }

  static async create(options: WebGpuTerminalRendererOptions): Promise<DomTerminalRenderer> {
    return new DomTerminalRenderer(options, options.bidi ? await loadBidiMapper() : undefined)
  }
}

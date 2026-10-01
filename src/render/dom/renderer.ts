import type { RenderRow } from '../../core/types.js'
import type { TerminalFittedFont } from '../../term/types.js'
import {
  canonicalRendererTheme,
  copyFittedFont,
  mergeRendererTheme,
  normalizeRendererGrid,
} from '../config.js'
import type { CanonicalRendererTheme, CursorState } from '../instances/types.js'
import type { RendererGridSize, WebGpuTerminalRendererOptions } from '../renderer.js'
import { RowTerminalRenderer, type RowRendererSurface } from '../row-renderer.js'
import { frameStyle, renderFrameToHtml, renderRowToHtml } from './html.js'

export { renderFrameToHtml } from './html.js'
export type { RenderFrameHtmlOptions } from './html.js'

class DomSurface implements RowRendererSurface {
  private readonly container: HTMLDivElement
  private readonly canvas: HTMLCanvasElement
  private readonly previousOpacity: string
  private font: TerminalFittedFont
  private grid: RendererGridSize
  private theme: CanonicalRendererTheme

  constructor(options: WebGpuTerminalRendererOptions) {
    if (!('ownerDocument' in options.canvas) || !options.canvas.parentElement) {
      throw new TypeError('The DOM renderer requires a canvas mounted in a terminal host')
    }
    this.canvas = options.canvas
    this.font = copyFittedFont(options.font)
    this.grid = normalizeRendererGrid(options)
    this.theme = canonicalRendererTheme(mergeRendererTheme(options.theme))
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
    this.canvas.style.opacity = this.previousOpacity
  }

  beginFrame(): void {
    this.position()
  }

  paint(row: RenderRow, cursor: CursorState | undefined): void {
    const previous = this.container.firstElementChild?.children[row.y]
    if (!previous) return
    const template = this.canvas.ownerDocument.createElement('template')
    template.innerHTML = renderRowToHtml(row, cursor, this.font, this.theme)
    previous.replaceWith(template.content)
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
    this.canvas.width = grid.columns * font.deviceCellWidth
    this.canvas.height = grid.rows * font.deviceCellHeight
    this.canvas.style.width = `${grid.columns * font.cssCellWidth}px`
    this.canvas.style.height = `${grid.rows * font.cssCellHeight}px`
    this.container.innerHTML = html
    this.position()
  }

  setTheme(theme: CanonicalRendererTheme): void {
    this.theme = theme
    this.container.firstElementChild?.setAttribute('style', frameStyle(this.font, this.grid, theme))
  }

  private position(): void {
    const style = this.canvas.ownerDocument.defaultView!.getComputedStyle(this.canvas)
    this.container.style.left = `${this.canvas.offsetLeft + (parseFloat(style.paddingLeft) || 0)}px`
    this.container.style.top = `${this.canvas.offsetTop + (parseFloat(style.paddingTop) || 0)}px`
  }
}

export class DomTerminalRenderer extends RowTerminalRenderer {
  readonly backend = 'dom' as const

  private constructor(options: WebGpuTerminalRendererOptions) {
    super(options, new DomSurface(options))
  }

  static create(options: WebGpuTerminalRendererOptions): Promise<DomTerminalRenderer> {
    return Promise.resolve(new DomTerminalRenderer(options))
  }
}

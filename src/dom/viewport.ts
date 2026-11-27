import type { RenderCell, RenderRow, TerminalScrollbar } from '../core/types.js'
import { CanvasRowPainter } from '../render/canvas/painter.js'
import { canonicalRendererTheme } from '../render/shared/config.js'
import { renderCursorState } from '../render/shared/cursor.js'
import type { RendererTheme } from '../render/shared/instances/types.js'
import type { TerminalFontSettings } from '../term/types.js'
import {
  decodeTerminalViewport,
  encodeTerminalViewport,
  isRgbColor,
  TERMINAL_VIEWPORT_MAX_BYTES,
  type PackedViewportCell,
  type SavedViewport,
} from './viewport-encode.js'

export { encodeTerminalViewport, TERMINAL_VIEWPORT_MAX_BYTES }

export interface TerminalViewportOptions {
  readonly font?: Partial<TerminalFontSettings>
  readonly theme?: Partial<RendererTheme>
}

export interface TerminalViewportPaint {
  readonly scrollbar: Readonly<TerminalScrollbar>
  readonly lines: readonly string[]
  dispose(): void
}

function unpackCell(value: PackedViewportCell): RenderCell {
  const [x, text, flags, foreground, background, underline] = value
  const style = {
    blink: Boolean(flags & 4),
    bold: Boolean(flags & 8),
    faint: Boolean(flags & 16),
    invisible: Boolean(flags & 32),
    inverse: Boolean(flags & 64),
    italic: Boolean(flags & 128),
    overline: Boolean(flags & 256),
    strikethrough: Boolean(flags & 512),
    underline,
  }
  return {
    x,
    text,
    continuation: Boolean(flags & 1),
    selected: Boolean(flags & 2),
    foreground: foreground ?? undefined,
    background: background ?? undefined,
    style,
  }
}

function unpackRow(row: readonly PackedViewportCell[], y: number, columns: number): RenderRow {
  const cells: RenderCell[] = Array.from({ length: columns }, (_, x) => ({
    x,
    text: '',
    continuation: false,
    selected: false,
  }))
  for (const cell of row) cells[cell[0]] = unpackCell(cell)
  return { y, cells, dirty: true }
}

function matchesAppearance(saved: SavedViewport, options: TerminalViewportOptions): boolean {
  if (
    options.font &&
    !Object.entries(options.font).every(
      ([key, value]) => Reflect.get(saved.font.settings, key) === value,
    )
  )
    return false
  if (!options.theme) return true
  return Object.entries(options.theme).every(([key, value]) => {
    const stored: unknown = Reflect.get(saved.theme, key)
    if (isRgbColor(value))
      return (
        isRgbColor(stored) && value.r === stored.r && value.g === stored.g && value.b === stored.b
      )
    return value === stored
  })
}

/** Draws native cells synchronously, without creating a terminal or accepting input. */
export function paintTerminalViewport(
  host: HTMLElement,
  serialized: string,
  options: TerminalViewportOptions = {},
): TerminalViewportPaint | undefined {
  const saved = decodeTerminalViewport(serialized)
  if (!saved || !matchesAppearance(saved, options)) return undefined
  if (
    Math.abs(host.clientWidth - saved.width) > 1 ||
    Math.abs(host.clientHeight - saved.height) > 1
  )
    return undefined
  if (host.ownerDocument.defaultView?.devicePixelRatio !== saved.font.pixelRatio) return undefined
  const canvas = host.ownerDocument.createElement('canvas')
  canvas.width = saved.columns * saved.font.deviceCellWidth
  canvas.height = saved.rows.length * saved.font.deviceCellHeight
  canvas.style.width = `${canvas.width / saved.font.pixelRatio}px`
  canvas.style.height = `${canvas.height / saved.font.pixelRatio}px`
  canvas.style.padding = `${saved.padding.top}px ${saved.padding.right}px ${saved.padding.bottom}px ${saved.padding.left}px`
  canvas.style.pointerEvents = 'none'
  canvas.style.display = 'block'
  canvas.setAttribute('aria-hidden', 'true')
  const context = canvas.getContext('2d')
  if (!context) return undefined
  // WebKit resolves generic fonts against the document only for a connected canvas.
  host.append(canvas)
  try {
    const painter = new CanvasRowPainter(context, saved.font, canonicalRendererTheme(saved.theme))
    painter.resetContext(saved.font)
    const cursor = renderCursorState(saved.cursor, true)
    const rows = saved.rows.map((row, y) => unpackRow(row, y, saved.columns))
    for (const row of rows) painter.paint(row, cursor, canvas.width)
    const lines = Object.freeze(
      rows.map((row) =>
        row.cells
          .filter((cell) => !cell.continuation)
          .map((cell) => cell.text || ' ')
          .join(''),
      ),
    )
    return {
      lines,
      scrollbar: Object.freeze({ ...saved.scrollbar }),
      dispose: () => canvas.remove(),
    }
  } catch (cause) {
    canvas.remove()
    throw cause
  }
}

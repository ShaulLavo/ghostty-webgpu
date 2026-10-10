import { emptyRenderCell } from '../../core/packed-cells.js'
import type { RenderCell, RenderRow, RgbColor } from '../../core/types.js'
import type { TerminalFittedFont } from '../../term/types.js'
import { CanvasColorCache, resolveCanvasCellColors } from '../canvas/colors.js'
import {
  canonicalRendererTheme,
  copyFittedFont,
  mergeRendererTheme,
  normalizeRendererGrid,
} from '../config.js'
import type { CanonicalRendererTheme, CursorState, RendererTheme } from '../instances/types.js'
import type { RendererFrameSnapshot, RendererGridSize } from '../renderer.js'

export interface RenderFrameHtmlOptions extends RendererGridSize {
  readonly font: TerminalFittedFont
  readonly theme?: Partial<RendererTheme>
}

function escapeHtml(value: string, attribute = false): string {
  const escaped = value.replace(
    /[&<>]/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]!,
  )
  return attribute ? escaped.replace(/"/g, '&quot;') : escaped
}

function cssFontFamily(family: string): string {
  if (/[;{}<>\\]/.test(family) || family.includes('/*') || family.includes('*/')) {
    throw new TypeError('font.settings.family must be a CSS font family list')
  }
  let quote: string | undefined
  for (const character of family) {
    const code = character.charCodeAt(0)
    if (code < 32 || code === 127)
      throw new TypeError('font.settings.family must be a CSS font family list')
    if (character !== '"' && character !== "'") continue
    if (quote === undefined) {
      quote = character
      continue
    }
    if (quote === character) quote = undefined
  }
  if (quote !== undefined)
    throw new TypeError('font.settings.family must be a CSS font family list')
  return family
}

export function frameStyle(
  font: TerminalFittedFont,
  grid: RendererGridSize,
  theme: CanonicalRendererTheme,
): string {
  const colors = new CanvasColorCache(theme.minimumContrast)
  return `width:calc(${grid.columns} * var(--ghostty-cell-width, ${font.cssCellWidth}px));height:calc(${grid.rows} * var(--ghostty-cell-height, ${font.cssCellHeight}px));contain:layout paint;overflow:hidden;white-space:pre;direction:ltr;unicode-bidi:bidi-override;text-align:left;font-variant-ligatures:none;font-family:${cssFontFamily(font.settings.family)};font-size:var(--ghostty-font-size, ${font.settings.size}px);font-weight:${font.settings.weight};line-height:var(--ghostty-cell-height, ${font.cssCellHeight}px);color:${colors.css(theme.foreground)};background-color:${colors.css(theme.background)}`
}

function cursorDecoration(
  cursor: CursorState | undefined,
  color: string,
  font: TerminalFittedFont,
  width: number,
): string {
  if (!cursor || cursor.style === 'block') return ''
  const pixel = 1 / font.pixelRatio
  const bar = Math.max(pixel, Math.floor(font.deviceCellWidth * 0.15) / font.pixelRatio)
  const underline = Math.max(pixel, Math.floor(font.deviceCellHeight * 0.16) / font.pixelRatio)
  const outline = Math.max(
    pixel,
    Math.floor(Math.min(font.deviceCellWidth, font.deviceCellHeight) * 0.08) / font.pixelRatio,
  )
  if (cursor.style === 'bar') return `box-shadow:inset ${bar}px 0 ${color};`
  if (width === 1 && cursor.style === 'underline')
    return `box-shadow:inset 0 -${underline}px ${color};`
  if (width === 1) return `box-shadow:inset 0 0 0 ${outline}px ${color};`
  const paint = `linear-gradient(${color},${color})`
  const cell = `var(--ghostty-cell-width, ${font.cssCellWidth}px)`
  if (cursor.style === 'underline')
    return `background-image:${paint};background-size:${cell} ${underline}px;background-position:left bottom;background-repeat:no-repeat;`
  return `background-image:${paint},${paint},${paint},${paint};background-size:${cell} ${outline}px,${cell} ${outline}px,${outline}px 100%,${outline}px 100%;background-position:left top,left bottom,left top,calc(${cell} - ${outline}px) top;background-repeat:no-repeat;`
}

function cellStyle(
  cell: RenderCell,
  cursor: CursorState | undefined,
  font: TerminalFittedFont,
  theme: CanonicalRendererTheme,
  colors: CanvasColorCache,
  width: number,
): string {
  const resolved = resolveCanvasCellColors(cell, theme, cursor?.style === 'block')
  const style = cell.style
  const foreground = colors.foreground(resolved)
  const decorations = [
    style?.underline ? 'underline' : '',
    style?.overline ? 'overline' : '',
    style?.strikethrough ? 'line-through' : '',
  ]
    .filter(Boolean)
    .join(' ')
  const underlineStyles = ['solid', 'solid', 'double', 'wavy', 'dotted', 'dashed']
  let css = `display:inline-block;flex:none;contain:size layout;direction:ltr;unicode-bidi:bidi-override;height:var(--ghostty-cell-height, ${font.cssCellHeight}px);vertical-align:top;`
  if (width > 1) css += 'text-align:center;'
  css += `color:${style?.invisible ? 'transparent' : foreground};`
  if (style?.faint && !style.invisible)
    css += `color:${foreground.replace('rgb(', 'rgba(').replace(')', ', 0.5)')};`
  if (resolved.drawBackground) css += `background-color:${colors.css(resolved.background)};`
  css += `font-weight:${style?.bold ? font.settings.boldWeight : font.settings.weight};font-style:${style?.italic ? 'italic' : 'normal'};`
  css += `letter-spacing:var(--ghostty-letter-spacing, calc(var(--ghostty-cell-width, ${font.cssCellWidth}px) - 1ch));`
  if (decorations)
    css += `text-decoration-line:${decorations};text-decoration-style:${underlineStyles[style?.underline ?? 0] ?? 'solid'};text-decoration-color:${foreground};`
  if (cursor?.style === 'block' && width > 1) {
    const tail = resolveCanvasCellColors(cell, theme, false)
    const paint = colors.css(theme.cursor)
    css += `background-color:${colors.css(tail.background)};background-image:linear-gradient(${paint},${paint});background-size:var(--ghostty-cell-width, ${font.cssCellWidth}px) 100%;background-repeat:no-repeat;`
  }
  return css + cursorDecoration(cursor, foreground, font, width)
}

function sameColor(left: RgbColor | undefined, right: RgbColor | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.r === right.r && left.g === right.g && left.b === right.b
}

function sameAppearance(left: RenderCell, right: RenderCell): boolean {
  return (
    sameColor(left.foreground, right.foreground) &&
    sameColor(left.background, right.background) &&
    left.selected === right.selected &&
    (left.style === right.style ||
      (left.style?.blink === right.style?.blink &&
        left.style?.bold === right.style?.bold &&
        left.style?.faint === right.style?.faint &&
        left.style?.invisible === right.style?.invisible &&
        left.style?.inverse === right.style?.inverse &&
        left.style?.italic === right.style?.italic &&
        left.style?.overline === right.style?.overline &&
        left.style?.strikethrough === right.style?.strikethrough &&
        left.style?.underline === right.style?.underline))
  )
}

export interface RowRun {
  readonly cursor: CursorState['style'] | undefined
  readonly style: string
  readonly text: string
}

export function defaultCellStyle(font: TerminalFittedFont, theme: CanonicalRendererTheme): string {
  return cellStyle(
    emptyRenderCell(),
    undefined,
    font,
    theme,
    new CanvasColorCache(theme.minimumContrast),
    1,
  )
}

function rowRunStyle(style: string, width: number, font: TerminalFittedFont): string {
  return `${style}width:calc(${width} * var(--ghostty-cell-width, ${font.cssCellWidth}px));`
}

export interface DefaultRowStyle {
  readonly cell: string
  readonly run: string
  readonly columns: number
}

export function defaultRowStyle(
  font: TerminalFittedFont,
  theme: CanonicalRendererTheme,
  columns: number,
): DefaultRowStyle {
  const cell = defaultCellStyle(font, theme)
  return { cell, run: rowRunStyle(cell, columns, font), columns }
}

export function renderRowRuns(
  row: RenderRow,
  cursor: CursorState | undefined,
  font: TerminalFittedFont,
  theme: CanonicalRendererTheme,
  styles?: DefaultRowStyle,
): readonly RowRun[] {
  const packed = row.packed
  const columns = packed?.length ?? row.cells.length
  const defaultStyle = styles?.cell
  const defaultRunStyle = styles?.columns === columns ? styles.run : undefined
  if (packed && defaultRunStyle !== undefined && (!cursor?.visible || cursor.y !== row.y)) {
    const text = packed.defaultRunText()
    if (text !== undefined) return text ? [{ cursor: undefined, style: defaultRunStyle, text }] : []
  }
  let colors: CanvasColorCache | undefined
  const scratchA = emptyRenderCell()
  const scratchB = emptyRenderCell()
  let length = columns
  const cursorEnd = cursor?.visible && cursor.y === row.y ? cursor.x + 1 : 0
  // The fixed-grid frame paints the default background; empty tails need no glyph layout.
  while (length > cursorEnd) {
    const cell = packed ? packed.read(length - 1, scratchB) : row.cells[length - 1]!
    // Retain trailing cells after wide glyphs to preserve their browser paint.
    if (cell.continuation) {
      length = columns
      break
    }
    if (cell.text || cell.selected || cell.foreground || cell.background || cell.style) break
    length -= 1
  }
  const runs: RowRun[] = []
  let currentStyle = ''
  let currentText = ''
  let currentWidth = 0
  let currentCursor: CursorState['style'] | undefined
  let previousCell: RenderCell | undefined
  function flush(): void {
    if (currentWidth === 0) return
    runs.push({
      cursor: currentCursor,
      style:
        defaultRunStyle !== undefined && currentStyle === defaultStyle && currentWidth === columns
          ? defaultRunStyle
          : rowRunStyle(currentStyle, currentWidth, font),
      text: currentText,
    })
    currentText = ''
    currentWidth = 0
  }
  for (let index = 0; index < length; index += 1) {
    const target = previousCell === scratchA ? scratchB : scratchA
    const cell = packed ? packed.read(index, target) : row.cells[index]!
    if (cell.continuation) continue
    let width = packed?.span(index) ?? 1
    while (!packed && row.cells[index + width]?.continuation) width += 1
    const paintedCursor =
      cursor?.visible && cursor.y === row.y && cursor.x === cell.x ? cursor : undefined
    // Cursor and wide-cell paint stays isolated; font, theme and contrast are fixed for this row.
    const reusable = width === 1 && !paintedCursor
    let style = currentStyle
    if (!(reusable && previousCell && sameAppearance(previousCell, cell))) {
      const defaultAppearance =
        defaultStyle !== undefined &&
        reusable &&
        !cell.selected &&
        !cell.foreground &&
        !cell.background &&
        !cell.style
      style =
        defaultStyle !== undefined && defaultAppearance
          ? defaultStyle
          : cellStyle(
              cell,
              paintedCursor,
              font,
              theme,
              (colors ??= new CanvasColorCache(theme.minimumContrast)),
              width,
            )
    }
    previousCell = reusable ? cell : undefined
    if (style !== currentStyle || paintedCursor || currentCursor || width > 1) flush()
    currentStyle = style
    currentCursor = paintedCursor?.style
    currentText += cell.text || ' '
    currentWidth += width
    // Wide glyphs occupy two cells but one character; their following run must start at its own cell.
    if (width > 1 || paintedCursor) flush()
  }
  if (length > 0 && length < columns) {
    const style =
      defaultStyle ??
      cellStyle(
        emptyRenderCell(),
        undefined,
        font,
        theme,
        (colors ??= new CanvasColorCache(theme.minimumContrast)),
        1,
      )
    // Keep default run widths stable as text changes, without laying out empty glyphs.
    if (style !== currentStyle || currentCursor) flush()
    currentStyle = style
    currentCursor = undefined
    currentWidth += columns - length
  }
  flush()
  return runs
}

function renderRowToHtml(
  row: RenderRow,
  cursor: CursorState | undefined,
  font: TerminalFittedFont,
  theme: CanonicalRendererTheme,
): string {
  const runs = renderRowRuns(row, cursor, font, theme).map((run) => {
    const cursorAttribute = run.cursor ? ` data-cursor="${escapeHtml(run.cursor, true)}"` : ''
    return `<span${cursorAttribute} style="${escapeHtml(run.style, true)}">${escapeHtml(run.text)}</span>`
  })
  return `<div data-row="${row.y}" style="display:flex;contain:size layout;direction:ltr;unicode-bidi:bidi-override;height:var(--ghostty-cell-height, ${font.cssCellHeight}px);">${runs.join('')}</div>`
}

export function renderFrameToHtml(
  snapshot: RendererFrameSnapshot,
  options: RenderFrameHtmlOptions,
): string {
  const font = copyFittedFont(options.font)
  const grid = normalizeRendererGrid(options)
  const theme = canonicalRendererTheme(mergeRendererTheme(options.theme))
  const byRow = new Map(snapshot.rows.map((row) => [row.y, row]))
  const rows = Array.from({ length: grid.rows }, (_, y) => {
    const row = byRow.get(y)
    return renderRowToHtml(
      { cells: row?.renderCells ?? [], dirty: true, y },
      snapshot.paintedCursor,
      font,
      theme,
    )
  })
  return `<div class="ghostty-webgpu-frame" aria-hidden="true" style="${escapeHtml(frameStyle(font, grid, theme), true)}">${rows.join('')}</div>`
}

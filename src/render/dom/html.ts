import type { RenderCell, RenderRow } from '../../core/types.js'
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
  return `width:calc(${grid.columns} * var(--ghostty-cell-width, ${font.cssCellWidth}px));height:calc(${grid.rows} * var(--ghostty-cell-height, ${font.cssCellHeight}px));overflow:hidden;white-space:pre;direction:ltr;unicode-bidi:bidi-override;text-align:left;font-variant-ligatures:none;font-family:${cssFontFamily(font.settings.family)};font-size:var(--ghostty-font-size, ${font.settings.size}px);font-weight:${font.settings.weight};line-height:var(--ghostty-cell-height, ${font.cssCellHeight}px);color:${colors.css(theme.foreground)};background-color:${colors.css(theme.background)}`
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
  let css = `display:inline-block;flex:none;direction:ltr;unicode-bidi:bidi-override;height:var(--ghostty-cell-height, ${font.cssCellHeight}px);vertical-align:top;`
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
  return css + cursorDecoration(cursor, colors.foreground(resolved), font, width)
}

export function renderRowToHtml(
  row: RenderRow,
  cursor: CursorState | undefined,
  font: TerminalFittedFont,
  theme: CanonicalRendererTheme,
): string {
  const colors = new CanvasColorCache(theme.minimumContrast)
  const runs: string[] = []
  let currentStyle = ''
  let currentText = ''
  let currentWidth = 0
  let currentCursor: string | undefined
  function flush(): void {
    if (currentWidth === 0) return
    const cursorAttribute = currentCursor ? ` data-cursor="${escapeHtml(currentCursor, true)}"` : ''
    runs.push(
      `<span${cursorAttribute} style="${escapeHtml(`${currentStyle}width:calc(${currentWidth} * var(--ghostty-cell-width, ${font.cssCellWidth}px));`, true)}">${escapeHtml(currentText)}</span>`,
    )
    currentText = ''
    currentWidth = 0
  }
  for (let index = 0; index < row.cells.length; index += 1) {
    const cell = row.cells[index]!
    if (cell.continuation) continue
    let width = 1
    while (row.cells[index + width]?.continuation) width += 1
    const paintedCursor =
      cursor?.visible && cursor.y === row.y && cursor.x === cell.x ? cursor : undefined
    const style = cellStyle(cell, paintedCursor, font, theme, colors, width)
    if (style !== currentStyle || paintedCursor || currentCursor || width > 1) flush()
    currentStyle = style
    currentCursor = paintedCursor?.style
    currentText += cell.text || ' '
    currentWidth += width
    // Wide glyphs occupy two cells but one character; their following run must start at its own cell.
    if (width > 1 || paintedCursor) flush()
  }
  flush()
  return `<div data-row="${row.y}" style="display:flex;direction:ltr;unicode-bidi:bidi-override;height:var(--ghostty-cell-height, ${font.cssCellHeight}px);">${runs.join('')}</div>`
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

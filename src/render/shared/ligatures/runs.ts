import type { RenderCell } from '../../../core/types.js'
import type { LigatureFinder, LigatureRange } from './finder.js'

// Native Ghostty and Rio keep these pairs apart: one narrow glyph would damage the cell grid.
export function latinPairBreak(previous: number, next: number): boolean {
  if (previous === 0x66) return next === 0x69 || next === 0x6c
  return previous === 0x73 && next === 0x74
}

function joinableCodepoint(cell: RenderCell, next: RenderCell | undefined): number | undefined {
  if (cell.continuation || next?.continuation || cell.style?.invisible) return undefined
  const codepoint = cell.text.codePointAt(0)
  // Symbols, box drawing and icons from U+2000 keep their per-cell sprites and constraints.
  if (codepoint === undefined || codepoint <= 0x20 || codepoint >= 0x2000) return undefined
  if (cell.text.length !== (codepoint > 0xffff ? 2 : 1)) return undefined
  return codepoint
}

function colorKey(color: RenderCell['foreground']): string {
  return color ? `${color.r},${color.g},${color.b}` : ''
}

// Everything that changes glyph ink. A background changes it under inverse, and under minimum
// contrast, where the glyph color is adjusted against each cell's own background.
function inkKey(cell: RenderCell, splitBackgrounds: boolean): string {
  const style = cell.style
  // An all-default style object paints like no style, as for a background-only SGR.
  const flags = style
    ? `${+style.bold}${+style.italic}${+style.faint}${+style.blink}${+style.inverse}` +
      `${+style.overline}${+style.strikethrough}${style.underline}`
    : '00000000'
  const background = style?.inverse || splitBackgrounds ? colorKey(cell.background) : ''
  return `${flags}|${colorKey(cell.foreground)}|${background}|${+cell.selected}`
}

/**
 * Joined runs as half-open cell ranges. Segments break at ink changes, wide or non-joinable cells
 * and Latin pairs; a range containing the visible cursor stays separate.
 */
export function ligatureRuns(
  cells: readonly RenderCell[],
  finder: LigatureFinder,
  cursorColumn: number | undefined,
  splitBackgrounds = false,
): LigatureRange[] {
  const runs: LigatureRange[] = []
  const codepoints: number[] = []
  let start = 0
  let key = ''
  const flush = (end: number) => {
    if (codepoints.length > 1) appendRuns(runs, finder.find(codepoints), start, cursorColumn)
    codepoints.length = 0
    start = end
  }
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index]!
    const codepoint = joinableCodepoint(cell, cells[index + 1])
    if (codepoint === undefined) {
      flush(index + 1)
      continue
    }
    const cellKey = inkKey(cell, splitBackgrounds)
    const previous = codepoints.at(-1)
    if (cellKey !== key || (previous !== undefined && latinPairBreak(previous, codepoint)))
      flush(index)
    key = cellKey
    codepoints.push(codepoint)
  }
  flush(cells.length)
  return runs
}

function appendRuns(
  runs: LigatureRange[],
  ranges: readonly LigatureRange[],
  offset: number,
  cursorColumn: number | undefined,
): void {
  for (const [first, last] of ranges) {
    const start = offset + first
    const end = offset + last
    if (cursorColumn !== undefined && cursorColumn >= start && cursorColumn < end) continue
    runs.push([start, end])
  }
}

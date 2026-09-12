import { rgb, type Rgb } from './ansi.js'
import type { CellBuffer } from './cells.js'
import { halfBlock } from './pixels.js'

// Traced from the Ghostty logo silhouette at 26 by 26 pixels, which is
// 26 columns by 13 rows once each cell shows two pixels. Half-block pixels
// are taller than wide, so a square trace lands at the logo's proportions.
// '.' clear, '#' body, '>' the chevron, '_' the cursor.
export const SPRITE_SHAPE = [
  '.........########.........',
  '......#############.......',
  '.....################.....',
  '...###################....',
  '..#####################...',
  '..######################..',
  '.##>>>##################..',
  '.###>>>##################.',
  '#####>>>#################.',
  '######>>>###__________####',
  '######>>>###__________####',
  '#####>>>####__________####',
  '####>>>###################',
  '###>>>####################',
  '##########################',
  '##########################',
  '##########################',
  '##########################',
  '##########################',
  '##########################',
  '##########################',
  '##########################',
  '#########################.',
  '.########################.',
  '..#######.######.#######..',
  '...#####...####...#####...',
]

export const SPRITE_WIDTH = SPRITE_SHAPE[0]!.length
export const SPRITE_HEIGHT = SPRITE_SHAPE.length
export const SPRITE_ROWS = SPRITE_HEIGHT / 2

export const ghostColors = {
  body: rgb('#E6E2F7'),
  face: rgb('#15131F'),
}

export interface GhostLook {
  /** Whether the underscore in the face is showing; it blinks like a cursor. */
  readonly cursorVisible: boolean
}

const defaultLook: GhostLook = { cursorVisible: true }

function shapeAt(x: number, y: number): string {
  return SPRITE_SHAPE[y]?.[x] ?? '.'
}

function pixelAt(x: number, y: number, look: GhostLook): Rgb | undefined {
  const char = shapeAt(x, y)
  if (char === '#') return ghostColors.body
  if (char === '>') return ghostColors.face
  if (char === '_') return look.cursorVisible ? ghostColors.face : ghostColors.body
  return undefined
}

/** Draws the ghost with its top-left body corner at a cell position. */
export function drawGhost(
  buffer: CellBuffer,
  col: number,
  row: number,
  look: GhostLook = defaultLook,
): void {
  for (let spriteRow = 0; spriteRow < SPRITE_ROWS; spriteRow += 1) {
    for (let x = 0; x < SPRITE_WIDTH; x += 1) {
      const top = pixelAt(x, spriteRow * 2, look)
      const bottom = pixelAt(x, spriteRow * 2 + 1, look)
      if (!top && !bottom) continue
      buffer.set(row + spriteRow, col + x, ...halfBlock(top, bottom))
    }
  }
}

/** The same ghost as plain text lines, for places without cursor control. */
export function ghostLines(look: GhostLook = defaultLook): string[] {
  const lines: string[] = []
  for (let spriteRow = 0; spriteRow < SPRITE_ROWS; spriteRow += 1) {
    let line = ''
    for (let x = 0; x < SPRITE_WIDTH; x += 1) {
      const top = pixelAt(x, spriteRow * 2, look)
      const bottom = pixelAt(x, spriteRow * 2 + 1, look)
      const [text, style] = halfBlock(top, bottom)
      line += style === '' ? text : `${style}${text}\x1b[0m`
    }
    lines.push(line)
  }
  return lines
}

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

// The ghostty.org animation renders a white ghost with a blue glow; match it.
export const ghostColors = {
  body: rgb('#F4F2FA'),
  face: rgb('#15131F'),
  glow: rgb('#3551F3'),
}

export interface GhostLook {
  /** Whether the underscore in the face is showing; it blinks like a cursor. */
  readonly cursorVisible: boolean
}

const defaultLook: GhostLook = { cursorVisible: true }

function shapeAt(x: number, y: number): string {
  return SPRITE_SHAPE[y]?.[x] ?? '.'
}

/** An empty pixel touching the body, so the glow hugs the ghost's edge. */
function isGlow(x: number, y: number): boolean {
  if (shapeAt(x, y) !== '.') return false
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const neighbor = shapeAt(x + dx, y + dy)
      if (neighbor === '#' || neighbor === '>') return true
    }
  }
  return false
}

function pixelAt(x: number, y: number, look: GhostLook): Rgb | undefined {
  const char = shapeAt(x, y)
  if (char === '#') return ghostColors.body
  if (char === '>') return ghostColors.face
  if (char === '_') return look.cursorVisible ? ghostColors.face : ghostColors.body
  return isGlow(x, y) ? ghostColors.glow : undefined
}

// One cell of margin all around leaves room for the glow ring.
export const GHOST_ART_WIDTH = SPRITE_WIDTH + 2
const GHOST_ART_ROWS = SPRITE_ROWS + 1

/** Draws the ghost with its top-left body corner at a cell position. */
export function drawGhost(
  buffer: CellBuffer,
  col: number,
  row: number,
  look: GhostLook = defaultLook,
): void {
  for (let spriteRow = -1; spriteRow < SPRITE_ROWS + 1; spriteRow += 1) {
    for (let x = -1; x < SPRITE_WIDTH + 1; x += 1) {
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
  for (let spriteRow = -1; spriteRow < GHOST_ART_ROWS; spriteRow += 1) {
    let line = ''
    for (let x = -1; x < SPRITE_WIDTH + 1; x += 1) {
      const top = pixelAt(x, spriteRow * 2, look)
      const bottom = pixelAt(x, spriteRow * 2 + 1, look)
      const [text, style] = halfBlock(top, bottom)
      line += style === '' ? text : `${style}${text}\x1b[0m`
    }
    lines.push(line)
  }
  return lines
}

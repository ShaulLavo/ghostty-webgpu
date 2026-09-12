import { mix, rgb, type Rgb } from './ansi.js'
import type { CellBuffer } from './cells.js'
import { halfBlock } from './pixels.js'

// '.' clear, '#' body, 'E' eye. 20 wide, 18 tall: 20 columns by 9 rows.
const SHAPE = [
  '......########......',
  '....############....',
  '...##############...',
  '..################..',
  '.##################.',
  '.###EEEE####EEEE###.',
  '.###EEEE####EEEE###.',
  '.###EEEE####EEEE###.',
  '.###EEEE####EEEE###.',
  '.##################.',
  '.##################.',
  '.##################.',
  '.##################.',
  '.##################.',
  '.##################.',
  '.##################.',
  '.####..######..####.',
  '.###....####....###.',
]

export const SPRITE_WIDTH = SHAPE[0]!.length
export const SPRITE_HEIGHT = SHAPE.length
export const SPRITE_ROWS = SPRITE_HEIGHT / 2

const EYES = [
  { left: 4, top: 5 },
  { left: 12, top: 5 },
]

export const ghostColors = {
  body: rgb('#E6E2F7'),
  eye: rgb('#15131F'),
  glint: rgb('#7EE6CE'),
}

export interface GhostLook {
  /** Pupil offset, each axis in -1..1. */
  readonly gazeX: number
  readonly gazeY: number
  readonly blinking: boolean
  readonly opacity: number
}

const defaultLook: GhostLook = { blinking: false, gazeX: 0, gazeY: 0, opacity: 1 }

function pixelAt(x: number, y: number, look: GhostLook, background: Rgb): Rgb | undefined {
  const row = SHAPE[y]
  if (!row) return undefined
  const char = row[x]
  if (char === undefined || char === '.') return undefined
  const body =
    look.opacity >= 1 ? ghostColors.body : mix(background, ghostColors.body, look.opacity)
  if (char === '#') return body
  if (look.blinking) return y === 7 ? mix(body, ghostColors.eye, 0.85) : body
  for (const eye of EYES) {
    const glintX = eye.left + 1 + Math.round(look.gazeX)
    const glintY = eye.top + 1 + Math.round(look.gazeY)
    if (x >= glintX && x < glintX + 2 && y >= glintY && y < glintY + 2) return ghostColors.glint
  }
  return ghostColors.eye
}

/** Draws the ghost with its top-left corner at a cell position. */
export function drawGhost(
  buffer: CellBuffer,
  col: number,
  row: number,
  background: Rgb,
  look: GhostLook = defaultLook,
): void {
  for (let spriteRow = 0; spriteRow < SPRITE_ROWS; spriteRow += 1) {
    for (let x = 0; x < SPRITE_WIDTH; x += 1) {
      const top = pixelAt(x, spriteRow * 2, look, background)
      const bottom = pixelAt(x, spriteRow * 2 + 1, look, background)
      if (!top && !bottom) continue
      buffer.set(row + spriteRow, col + x, ...halfBlock(top, bottom))
    }
  }
}

/** The same ghost as plain text lines, for places without cursor control. */
export function ghostLines(look: GhostLook = defaultLook): string[] {
  const background = rgb('#15131F')
  const lines: string[] = []
  for (let spriteRow = 0; spriteRow < SPRITE_ROWS; spriteRow += 1) {
    let line = ''
    for (let x = 0; x < SPRITE_WIDTH; x += 1) {
      const top = pixelAt(x, spriteRow * 2, look, background)
      const bottom = pixelAt(x, spriteRow * 2 + 1, look, background)
      const [text, style] = halfBlock(top, bottom)
      line += style === '' ? text : `${style}${text}\x1b[0m`
    }
    lines.push(line)
  }
  return lines
}

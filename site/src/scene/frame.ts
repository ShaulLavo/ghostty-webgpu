import type { Piece } from 'ascii.rest'

// A scene's resting frame as text, in four '|'-separated parts: its columns and rows, its palette, a row of dots per
// scene row (' ', '.', 'o', 'O' for ascii.rest's ' ', '·', '•', '●'), and one palette index per dot as a character
// from '0'.
const DOTS: Readonly<Record<string, string>> = { '·': '.', '•': 'o', '●': 'O' }

export function frameText(piece: Piece): string {
  const { cols, rows, palette = [], still = 0 } = piece.meta
  const color = new Uint8Array(cols * rows)
  const lines = piece.default(piece.meta.options)(still, { paper: false, color }).split('\n')
  const dots: string[] = []
  let colors = ''
  for (let y = 0; y < rows; y++) {
    let row = ''
    for (let x = 0; x < cols; x++) {
      const dot = DOTS[lines[y]?.[x] ?? ' '] ?? ' '
      row += dot
      if (dot !== ' ') colors += String.fromCharCode(48 + color[y * cols + x]!)
    }
    dots.push(row.trimEnd())
  }
  return [`${cols},${rows}`, palette.join(','), dots.join('\n'), colors].join('|')
}

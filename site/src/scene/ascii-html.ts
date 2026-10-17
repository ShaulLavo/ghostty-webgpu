import type { Piece } from 'ascii.rest'

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
const escape = (text: string) => text.replace(/[&<>]/g, (character) => ESCAPES[character]!)

/**
 * One frame of an ascii.rest piece as HTML text: the characters it draws, in runs of one colour, as its canvas would
 * paint them. `ink` names the CSS colour for each palette entry.
 */
export function frameHtml(
  piece: Piece,
  t: number,
  ink: (index: number, hex: string) => string,
): string {
  const { cols, rows, palette = [] } = piece.meta
  const color = new Uint8Array(cols * rows)
  const lines = piece.default(piece.meta.options)(t, { paper: false, color }).split('\n')
  return lines
    .map((line, y) => {
      let html = ''
      let run = ''
      let current = -1
      for (let x = 0; x < line.length; x++) {
        const index = line[x] === ' ' ? current : color[y * cols + x]!
        if (index !== current && run) {
          html +=
            current < 0
              ? escape(run)
              : `<span style="color:${ink(current, palette[current]!)}">${escape(run)}</span>`
          run = ''
        }
        current = index
        run += line[x]
      }
      if (run)
        html +=
          current < 0
            ? escape(run)
            : `<span style="color:${ink(current, palette[current]!)}">${escape(run)}</span>`
      return html
    })
    .join('\n')
}

import type { LinkCell, LinkLineSnapshot } from '../src/term/links.js'

function startCell(starts: readonly number[], ends: readonly number[], boundary: number) {
  for (let column = 0; column < starts.length; column += 1) {
    if (starts[column]! <= boundary && ends[column]! > boundary) return column
  }
  return undefined
}

function endCell(
  cells: readonly LinkCell[],
  starts: readonly number[],
  ends: readonly number[],
  boundary: number,
) {
  for (let column = starts.length - 1; column >= 0; column -= 1) {
    if (starts[column]! >= boundary || ends[column]! < boundary) continue
    let end = column
    while (cells[end + 1]?.continuation) {
      end += 1
    }
    return end
  }
  return undefined
}

export function createLinkLineSnapshot(line: readonly LinkCell[]): LinkLineSnapshot {
  const cells = line.map((cell) => ({ continuation: cell.continuation === true, text: cell.text }))
  const starts: number[] = []
  const ends: number[] = []
  let text = ''
  for (const cell of cells) {
    starts.push(text.length)
    text += cell.continuation ? '' : cell.text || ' '
    ends.push(text.length)
  }
  const startCellByTextBoundary: (number | undefined)[] = []
  const endCellByTextBoundary: (number | undefined)[] = []
  for (let boundary = 0; boundary <= text.length; boundary += 1) {
    startCellByTextBoundary.push(startCell(starts, ends, boundary))
    endCellByTextBoundary.push(endCell(cells, starts, ends, boundary))
  }
  return {
    cells,
    text,
    textStartByCell: starts,
    textEndByCell: ends,
    startCellByTextBoundary,
    endCellByTextBoundary,
  }
}

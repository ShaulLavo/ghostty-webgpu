import { cup, reset, syncEnd, syncStart } from './ansi.js'

interface Cell {
  readonly style: string
  readonly text: string
}

const COL_STRIDE = 4096

function key(row: number, col: number): number {
  return row * COL_STRIDE + col
}

/**
 * Double-buffered grid of styled cells. `flush` writes only the cells that
 * changed since the previous flush, which is what a damage-aware renderer
 * wants to see.
 */
export class CellBuffer {
  private current = new Map<number, Cell>()
  private next = new Map<number, Cell>()

  set(row: number, col: number, text: string, style = ''): void {
    if (row < 0 || col < 0) return
    this.next.set(key(row, col), { style, text })
  }

  text(row: number, col: number, value: string, style = ''): void {
    let offset = 0
    for (const char of value) {
      this.set(row, col + offset, char, style)
      offset += 1
    }
  }

  /** Returns the number of cells written. */
  flush(write: (data: string) => void): number {
    const writes: number[] = []
    for (const [id, cell] of this.next) {
      const previous = this.current.get(id)
      if (previous && previous.text === cell.text && previous.style === cell.style) continue
      writes.push(id)
    }
    for (const id of this.current.keys()) {
      if (this.next.has(id)) continue
      writes.push(id)
      this.next.set(id, { style: '', text: ' ' })
    }
    if (writes.length === 0) return 0

    writes.sort((a, b) => a - b)
    let out = syncStart
    let lastRow = -1
    let lastCol = -1
    let lastStyle = reset
    for (const id of writes) {
      const row = Math.floor(id / COL_STRIDE)
      const col = id % COL_STRIDE
      const cell = this.next.get(id)
      if (!cell) continue
      if (row !== lastRow || col !== lastCol) out += cup(row, col)
      const style = cell.style === '' ? reset : cell.style
      if (style !== lastStyle) {
        out += reset + cell.style
        lastStyle = style
      }
      out += cell.text
      lastRow = row
      lastCol = col + 1
    }
    out += reset + syncEnd
    write(out)

    // Erased cells are not worth remembering.
    for (const [id, cell] of this.next) {
      if (cell.text === ' ' && cell.style === '') this.next.delete(id)
    }
    const swap = this.current
    this.current = this.next
    this.next = swap
    this.next.clear()
    return writes.length
  }

  /** Forget everything without writing. Use after the terminal was reset. */
  forget(): void {
    this.current.clear()
    this.next.clear()
  }
}

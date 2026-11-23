import type { CellStyle, RenderCell, RgbColor } from './types.js'

export const PACKED_CELL_WORDS = 6
export const PACKED_ROW_WORDS = 4
// String.fromCharCode.apply stays well under engine argument limits at this size.
const unitChunk = 4096
// Index 0 maps to '' because a zero codepoint is an empty cell.
const asciiText = Array.from({ length: 128 }, (_, code) =>
  code === 0 ? '' : String.fromCharCode(code),
)
let unitScratch = new Uint16Array(1024)

/** Text for one scalar; zero is an empty cell. */
export function codepointText(codepoint: number): string {
  return codepoint < 128 ? asciiText[codepoint]! : String.fromCodePoint(codepoint)
}

function ensureUnits(used: number, capacity: number): Uint16Array<ArrayBuffer> {
  if (capacity <= unitScratch.length) return unitScratch
  const grown = new Uint16Array(Math.max(capacity, unitScratch.length * 2))
  grown.set(unitScratch.subarray(0, used))
  unitScratch = grown
  return grown
}

function putCodepoint(units: Uint16Array, index: number, codepoint: number): number {
  if (codepoint <= 0xffff) {
    units[index] = codepoint
    return index + 1
  }
  const value = codepoint - 0x10000
  units[index] = 0xd800 | (value >>> 10)
  units[index + 1] = 0xdc00 | (value & 0x3ff)
  return index + 2
}

function putWord(units: Uint16Array, index: number, word: number): number {
  units[index] = word & 0xffff
  units[index + 1] = word >>> 16
  return index + 2
}

function unitsText(units: Uint16Array, length: number): string {
  let text = ''
  for (let start = 0; start < length; start += unitChunk) {
    const chunk = units.subarray(start, Math.min(length, start + unitChunk))
    text += String.fromCharCode.apply(null, chunk as unknown as number[])
  }
  return text
}

function color(value: number, previous: RgbColor | undefined): RgbColor | undefined {
  if (value === 0xffffffff) return undefined
  const result = previous ?? { r: 0, g: 0, b: 0 }
  result.r = value & 255
  result.g = (value >>> 8) & 255
  result.b = (value >>> 16) & 255
  return result
}

function style(flags: number, previous: CellStyle | undefined): CellStyle | undefined {
  if ((flags & 8) === 0) return undefined
  const result = previous ?? ({} as CellStyle)
  result.bold = (flags & (1 << 4)) !== 0
  result.italic = (flags & (1 << 5)) !== 0
  result.faint = (flags & (1 << 6)) !== 0
  result.blink = (flags & (1 << 7)) !== 0
  result.inverse = (flags & (1 << 8)) !== 0
  result.invisible = (flags & (1 << 9)) !== 0
  result.strikethrough = (flags & (1 << 10)) !== 0
  result.overline = (flags & (1 << 11)) !== 0
  result.underline = flags >>> 12
  return result
}

export function emptyRenderCell(): RenderCell {
  return { continuation: false, selected: false, text: '', x: 0 }
}

export class PackedCells {
  readonly length: number
  private defaultText: string | null | undefined
  private defaultTail = 0

  constructor(
    private readonly words: Uint32Array,
    private readonly graphemes: Uint32Array,
  ) {
    this.length = words.length / PACKED_CELL_WORDS
  }

  // The target and its color/style objects are reused scratch; finish using them before the next read.
  read(index: number, target: RenderCell): RenderCell {
    const offset = index * PACKED_CELL_WORDS
    const flags = this.words[offset + 3]!
    target.x = index
    target.continuation = (flags & 3) === 2
    target.selected = (flags & 4) !== 0
    target.foreground = color(this.words[offset + 1]!, target.foreground)
    target.background = color(this.words[offset + 2]!, target.background)
    target.style = style(flags, target.style)
    target.text = this.textAt(offset)
    return target
  }

  defaultRunText(padToColumns = false): string | undefined {
    // Owned packed records preserve this projection for the row snapshot's lifetime.
    if (this.defaultText === undefined) this.defaultText = this.projectDefaultRun()
    const text = this.defaultText
    if (text === null) return undefined
    return padToColumns ? text + ' '.repeat(this.defaultTail) : text
  }

  private projectDefaultRun(): string | null {
    const words = this.words
    let end = 0
    for (let offset = 0; offset < words.length; offset += PACKED_CELL_WORDS) {
      if (
        (words[offset + 3]! & ~1) !== 0 ||
        words[offset + 1] !== 0xffffffff ||
        words[offset + 2] !== 0xffffffff
      )
        return null
      if (words[offset] !== 0 || words[offset + 5] !== 0) end = offset + PACKED_CELL_WORDS
    }
    let units = unitScratch
    let index = 0
    for (let offset = 0; offset < end; offset += PACKED_CELL_WORDS) {
      units = ensureUnits(index, index + 2 * (words[offset + 5]! || 1))
      const next = this.putText(units, index, offset)
      if (next !== index) {
        index = next
        continue
      }
      units[index] = 0x20
      index += 1
    }
    this.defaultTail = (words.length - end) / PACKED_CELL_WORDS
    return unitsText(units, index)
  }

  hasBlinkingText(): boolean {
    for (let offset = 0; offset < this.words.length; offset += PACKED_CELL_WORDS) {
      const flags = this.words[offset + 3]!
      if ((flags & (1 << 7)) === 0 || (flags & (1 << 9)) !== 0) continue
      if (flags >>> 12 !== 0 || (flags & ((1 << 10) | (1 << 11))) !== 0) return true
      if ((flags & 3) !== 2 && this.textAt(offset).trim().length > 0) return true
    }
    return false
  }

  span(index: number): number {
    let span = 1
    while (
      index + span < this.length &&
      (this.words[(index + span) * PACKED_CELL_WORDS + 3]! & 3) === 2
    )
      span += 1
    return span
  }

  // Private synchronous consumers own this scratch; published rows materialize independently.
  readInto(target: RenderCell[]): readonly RenderCell[] {
    for (let index = 0; index < this.length; index += 1)
      target[index] = this.read(index, target[index] ?? emptyRenderCell())
    target.length = this.length
    return target
  }

  /**
   * A compact key equal exactly when every cell's text, colors and flags match. Each cell is a
   * text-length unit, its UTF-16 text, then fixed-width foreground, background and flag words.
   */
  identity(): string {
    const words = this.words
    let units = unitScratch
    let index = 0
    for (let offset = 0; offset < words.length; offset += PACKED_CELL_WORDS) {
      units = ensureUnits(index, index + 7 + 2 * (words[offset + 5]! || 1))
      // Grapheme offsets are frame-local; only the decoded text enters the key.
      const textStart = index + 1
      index = this.putText(units, textStart, offset)
      units[textStart - 1] = index - textStart
      index = putWord(units, index, words[offset + 1]!)
      index = putWord(units, index, words[offset + 2]!)
      index = putWord(units, index, words[offset + 3]!)
    }
    return unitsText(units, index)
  }

  materialize(): readonly RenderCell[] {
    return Array.from({ length: this.length }, (_, index) => this.read(index, emptyRenderCell()))
  }

  text(index: number): string {
    return this.textAt(index * PACKED_CELL_WORDS)
  }

  continuation(index: number): boolean {
    return (this.words[index * PACKED_CELL_WORDS + 3]! & 3) === 2
  }

  /** Writes the cell's UTF-16 units at `index` and returns the end index. */
  private putText(units: Uint16Array, index: number, offset: number): number {
    const length = this.words[offset + 5]!
    if (length === 0) {
      const codepoint = this.words[offset]!
      return codepoint === 0 ? index : putCodepoint(units, index, codepoint)
    }
    const start = this.words[offset + 4]!
    let end = index
    for (let cursor = start; cursor < start + length; cursor += 1)
      end = putCodepoint(units, end, this.graphemes[cursor]!)
    return end
  }

  private textAt(offset: number): string {
    const length = this.words[offset + 5]!
    if (length === 0) return codepointText(this.words[offset]!)
    const start = this.words[offset + 4]!
    let text = ''
    for (let index = start; index < start + length; index += 1)
      text += String.fromCodePoint(this.graphemes[index]!)
    return text
  }
}

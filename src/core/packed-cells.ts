import type { CellStyle, RenderCell, RgbColor } from './types.js'

export const PACKED_CELL_WORDS = 6
export const PACKED_ROW_WORDS = 4

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
    let text = ''
    for (let offset = 0; offset < end; offset += PACKED_CELL_WORDS)
      text += this.textAt(offset) || ' '
    this.defaultTail = (words.length - end) / PACKED_CELL_WORDS
    return text
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

  identity(): string {
    let identity = ''
    for (let offset = 0; offset < this.words.length; offset += PACKED_CELL_WORDS) {
      const text = this.textAt(offset)
      const foreground = this.words[offset + 1]!
      const background = this.words[offset + 2]!
      const fg = foreground === 0xffffffff ? '-' : foreground.toString(16)
      const bg = background === 0xffffffff ? '-' : background.toString(16)
      // Grapheme offsets are frame-local; length-prefixed text keeps cell boundaries distinct.
      identity += `${text.length}:${text}:${fg}:${bg}:${this.words[offset + 3]!.toString(16)};`
    }
    return identity
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

  private textAt(offset: number): string {
    const length = this.words[offset + 5]!
    if (length === 0) {
      const codepoint = this.words[offset]!
      if (codepoint === 0) return ''
      return String.fromCodePoint(codepoint)
    }
    const start = this.words[offset + 4]!
    let text = ''
    for (let index = start; index < start + length; index += 1)
      text += String.fromCodePoint(this.graphemes[index]!)
    return text
  }
}

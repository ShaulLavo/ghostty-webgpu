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

  constructor(
    private readonly words: Uint32Array,
    private readonly graphemes: Uint32Array,
  ) {
    this.length = words.length / PACKED_CELL_WORDS
  }

  // The target is a scratch cell. Consumers finish using it before the next read.
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

  span(index: number): number {
    let span = 1
    while (
      index + span < this.length &&
      (this.words[(index + span) * PACKED_CELL_WORDS + 3]! & 3) === 2
    )
      span += 1
    return span
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

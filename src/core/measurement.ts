import { createGhosttyError } from './error.js'
import type { GhosttyRuntime } from './runtime.js'
import type { TerminalMeasuredText, TerminalPrintingUnit } from './types.js'

interface PrintingText {
  readonly codepoints: readonly number[]
  readonly offsets: readonly number[]
}

export function printingText(text: string): PrintingText {
  if (typeof text !== 'string') {
    throw createGhosttyError('terminal.measure', 'Measurement requires plain printable text')
  }
  const codepoints: number[] = []
  const offsets = [0]
  let offset = 0
  for (const character of text) {
    const codepoint = character.codePointAt(0)!
    if (codepoint < 0x20 || (codepoint >= 0x7f && codepoint <= 0x9f)) {
      throw createGhosttyError('terminal.measure', 'Measurement requires plain printable text')
    }
    // UTF8 output replaces unpaired surrogates with U+FFFD; retain the caller's UTF16 range.
    codepoints.push(codepoint >= 0xd800 && codepoint <= 0xdfff ? 0xfffd : codepoint)
    offset += character.length
    offsets.push(offset)
  }
  return { codepoints, offsets }
}

export function measurePrintingText(
  runtime: GhosttyRuntime,
  text: PrintingText,
  graphemeClustering: boolean,
): TerminalMeasuredText {
  const units: TerminalPrintingUnit[] = []
  let cells = 0
  const { codepoints, offsets } = text
  if (codepoints.length === 0) return Object.freeze({ cells, units: Object.freeze(units) })
  const { memory, exports } = runtime
  const size = codepoints.length * 4 + 1
  const pointer = memory.allocate(size)
  const width = pointer + codepoints.length * 4
  try {
    for (let index = 0; index < codepoints.length; index += 1) {
      memory.view.setUint32(pointer + index * 4, codepoints[index]!, true)
    }
    for (let index = 0; index < codepoints.length;) {
      const consumed = graphemeClustering
        ? exports.ghostty_unicode_grapheme_width(
            pointer + index * 4,
            codepoints.length - index,
            width,
          )
        : 1
      const count = graphemeClustering
        ? memory.view.getUint8(width)
        : exports.ghostty_unicode_codepoint_width(codepoints[index]!)
      if (consumed < 1 || consumed > codepoints.length - index || count > 2) {
        throw createGhosttyError(
          'terminal.measure',
          'Native Unicode measurement returned an invalid printing unit',
        )
      }
      units.push(
        Object.freeze({ start: offsets[index]!, end: offsets[index + consumed]!, cells: count }),
      )
      cells += count
      index += consumed
    }
    return Object.freeze({ cells, units: Object.freeze(units) })
  } finally {
    memory.free(pointer, size)
  }
}

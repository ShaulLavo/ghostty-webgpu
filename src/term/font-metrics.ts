import type { TerminalFontMetrics } from './types.js'

interface Table {
  offset: number
  length: number
}

function table(view: DataView, tag: number): Table | undefined {
  const count = view.getUint16(4)
  if (12 + count * 16 > view.byteLength) return undefined
  for (let index = 0; index < count; index++) {
    const entry = 12 + index * 16
    if (view.getUint32(entry) !== tag) continue
    const offset = view.getUint32(entry + 8)
    const length = view.getUint32(entry + 12)
    if (offset + length > view.byteLength) return undefined
    return { offset, length }
  }
  return undefined
}

/** Reads uncompressed OpenType/TrueType font tables. Unavailable metrics stay unknown. */
export function readSfntFontMetrics(bytes: Uint8Array): TerminalFontMetrics | undefined {
  if (bytes.byteLength < 12) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint32(0)
  if (version !== 0x00010000 && version !== 0x4f54544f) return undefined
  const head = table(view, 0x68656164)
  const post = table(view, 0x706f7374)
  if (!head || head.length < 20 || !post || post.length < 12) return undefined
  const unitsPerEm = view.getUint16(head.offset + 18)
  const underlineThickness = view.getInt16(post.offset + 10)
  if (unitsPerEm === 0 || underlineThickness <= 0) return undefined
  return Object.freeze({ unitsPerEm, underlineThickness })
}

export function normalizeFontMetrics(
  metrics: TerminalFontMetrics | undefined,
): TerminalFontMetrics | undefined {
  if (metrics === undefined) return undefined
  if (
    !Number.isInteger(metrics.unitsPerEm) ||
    metrics.unitsPerEm <= 0 ||
    metrics.unitsPerEm > 65535
  )
    throw new RangeError('font.metrics.unitsPerEm must be a positive uint16')
  if (
    !Number.isInteger(metrics.underlineThickness) ||
    metrics.underlineThickness <= 0 ||
    metrics.underlineThickness > 32767
  )
    throw new RangeError('font.metrics.underlineThickness must be a positive int16')
  return Object.freeze({
    unitsPerEm: metrics.unitsPerEm,
    underlineThickness: metrics.underlineThickness,
  })
}

export function fontMetricsEqual(
  left: TerminalFontMetrics | undefined,
  right: TerminalFontMetrics | undefined,
): boolean {
  return (
    left?.unitsPerEm === right?.unitsPerEm && left?.underlineThickness === right?.underlineThickness
  )
}

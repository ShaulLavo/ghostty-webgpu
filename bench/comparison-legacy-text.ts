import type { Terminal as GhosttyWeb } from 'ghostty-web'

export function legacyText(terminal: GhosttyWeb): string[] {
  const core = terminal.wasmTerm
  if (!core) throw new TypeError('Ghostty Web benchmark render buffer is unavailable')
  // The public buffer drops grapheme tails that the pinned renderer draws.
  return Array.from({ length: terminal.rows }, (_, y) =>
    (core.getLine(y) ?? [])
      .map((cell, x) => {
        if (cell.width === 0) return ''
        if (cell.grapheme_len > 0) return core.getGraphemeString(y, x)
        return String.fromCodePoint(cell.codepoint || 32)
      })
      .join('')
      .trimEnd(),
  )
}

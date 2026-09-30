import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
const compact = (text: string) => text.replace(/[\s;]/g, '')
const methodBody = (file: string) => {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  return (
    source.match(/getSelection\(options:[\s\S]*?\): string \| undefined \{([\s\S]*?)\n  \}/)?.[1] ??
    ''
  )
}

describe('native selection copy path', () => {
  it('delegates gesture copy directly to the uncapped native terminal path', () => {
    expect(compact(methodBody('../selection.ts'))).toBe(
      'this.ensureActive()returnthis.terminal.getSelection(options)',
    )
    expect(compact(methodBody('../terminal.ts'))).toBe(
      'this.ensureActive()returnreadSelectionText(this,options)',
    )
  })

  it('formats text natively and reads only row metadata in history', () => {
    const native = readFileSync(new URL('../native-text.ts', import.meta.url), 'utf8')
    const history = readFileSync(new URL('../grid-text.ts', import.meta.url), 'utf8')
    expect(native).toContain('ghostty_terminal_selection_format_buf')
    expect(native).not.toMatch(/ghostty_grid_ref_|TERMINAL_READ_LINES_MAX_ROWS/)
    expect(history).toContain(
      'readSelectionText(terminal, { unwrap: false, trim: false }, range.selection)',
    )
    expect(history).not.toMatch(/ghostty_grid_ref_cell|ghostty_cell_get|ghostty_grid_ref_graphemes/)
  })
})

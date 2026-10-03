import { describe, expect, it, vi } from 'vitest'
import { GhosttyRuntime } from '../../core/runtime.js'
import type { CellStyle } from '../../core/types.js'
import { CanvasColorCache } from '../canvas/colors.js'
import { canonicalRendererTheme, mergeRendererTheme } from '../config.js'
import { renderRowRuns } from './html.js'
import { probeFont } from './tests/probe.js'

const theme = canonicalRendererTheme(mergeRendererTheme({}))

describe('adjacent DOM appearance projection', () => {
  it('serializes one style per adjacent appearance and starts fresh for every row', async () => {
    const runtime = await GhosttyRuntime.create()
    const foreground = vi.spyOn(CanvasColorCache.prototype, 'foreground')
    try {
      const terminal = runtime.createTerminal({ columns: 12, rows: 2 })
      const state = runtime.createRenderState(terminal)
      terminal.write('\x1b[?25labcdefghijkl\r\nabcdefghijkl')
      state.update()
      for (const row of state.readRows()) {
        const runs = renderRowRuns(row, undefined, probeFont, theme)
        expect(runs).toHaveLength(1)
        expect(runs[0]!.text).toBe('abcdefghijkl')
        expect(runs[0]!.style).toContain('width:calc(12 * var(--ghostty-cell-width, 10px));')
      }
      expect(foreground).toHaveBeenCalledTimes(2)
    } finally {
      foreground.mockRestore()
      runtime.dispose()
    }
  })

  it('looks up foreground once per appearance when every cell alternates', async () => {
    const runtime = await GhosttyRuntime.create()
    const foreground = vi.spyOn(CanvasColorCache.prototype, 'foreground')
    try {
      const terminal = runtime.createTerminal({ columns: 12, rows: 1 })
      const state = runtime.createRenderState(terminal)
      terminal.write(`\x1b[?25l${'\x1b[31mA\x1b[32mB'.repeat(6)}`)
      state.update()
      const row = state.readRows()[0]!
      const runs = renderRowRuns(row, undefined, probeFont, theme)
      expect(runs).toHaveLength(12)
      expect(runs.map((run) => run.text).join('')).toBe('AB'.repeat(6))
      expect(foreground).toHaveBeenCalledTimes(12)
    } finally {
      foreground.mockRestore()
      runtime.dispose()
    }
  })

  it.each([
    '1',
    '2',
    '3',
    '4',
    '5',
    '7',
    '8',
    '9',
    '53',
    '4:2',
    '4:3',
    '4:4',
    '4:5',
    '38;2;90;100;110',
    '48;2;20;25;30',
  ])('recomputes appearance at SGR %s boundaries while reusing its adjacent cells', async (sgr) => {
    const runtime = await GhosttyRuntime.create()
    const foreground = vi.spyOn(CanvasColorCache.prototype, 'foreground')
    try {
      const terminal = runtime.createTerminal({ columns: 4, rows: 1 })
      const state = runtime.createRenderState(terminal)
      terminal.write(`\x1b[?25lA\x1b[${sgr}mBC\x1b[0mD`)
      state.update()
      const row = state.readRows()[0]!
      expect(
        renderRowRuns(row, undefined, probeFont, theme)
          .map((run) => run.text)
          .join(''),
      ).toBe('ABCD')
      expect(foreground).toHaveBeenCalledTimes(3)
    } finally {
      foreground.mockRestore()
      runtime.dispose()
    }
  })

  it('checks selection even when adjacent cells share their style object', async () => {
    const runtime = await GhosttyRuntime.create()
    const foreground = vi.spyOn(CanvasColorCache.prototype, 'foreground')
    try {
      const terminal = runtime.createTerminal({ columns: 4, rows: 1 })
      const state = runtime.createRenderState(terminal)
      terminal.write('\x1b[?25l\x1b[1mABCD')
      state.update()
      const row = state.readRows()[0]!
      const cells = row.cells.map((cell, index) => ({
        ...cell,
        style: row.cells[0]!.style,
        selected: index === 1 || index === 2,
      }))
      const runs = renderRowRuns({ ...row, cells }, undefined, probeFont, theme)
      expect(runs.map((run) => run.text)).toEqual(['A', 'BC', 'D'])
      expect(runs[1]!.style).toContain('background-color:rgb(51, 68, 85);')
      expect(foreground).toHaveBeenCalledTimes(3)
    } finally {
      foreground.mockRestore()
      runtime.dispose()
    }
  })

  it('reads undefined style references once per neighboring cell', async () => {
    const runtime = await GhosttyRuntime.create()
    try {
      const terminal = runtime.createTerminal({ columns: 4, rows: 1 })
      const state = runtime.createRenderState(terminal)
      terminal.write('\x1b[?25lABCD')
      state.update()
      const row = state.readRows()[0]!
      let reads = 0
      for (const cell of row.cells) {
        Object.defineProperty(cell, 'style', {
          get() {
            reads++
            return undefined
          },
        })
      }
      const runs = renderRowRuns(row, undefined, probeFont, theme)
      expect(runs.map((run) => run.text)).toEqual(['ABCD'])
      expect(reads).toBe(8)
    } finally {
      runtime.dispose()
    }
  })

  it('skips structural flag reads for a shared style reference', async () => {
    const runtime = await GhosttyRuntime.create()
    try {
      const terminal = runtime.createTerminal({ columns: 4, rows: 1 })
      const state = runtime.createRenderState(terminal)
      terminal.write('\x1b[?25l\x1b[1mABCD')
      state.update()
      const row = state.readRows()[0]!
      const style = { ...row.cells[0]!.style! }
      let blinkReads = 0
      Object.defineProperty(style, 'blink', {
        get() {
          blinkReads++
          return false
        },
      })
      const cells = row.cells.map((cell) => ({ ...cell, style }))
      const runs = renderRowRuns({ ...row, cells }, undefined, probeFont, theme)
      expect(runs.map((run) => run.text)).toEqual(['ABCD'])
      expect(runs[0]!.style).toContain('font-weight:700;')
      expect(blinkReads).toBe(0)
    } finally {
      runtime.dispose()
    }
  })

  it('compares distinct but equal style references structurally', async () => {
    const runtime = await GhosttyRuntime.create()
    try {
      const terminal = runtime.createTerminal({ columns: 4, rows: 1 })
      const state = runtime.createRenderState(terminal)
      terminal.write('\x1b[?25l\x1b[1mABCD')
      state.update()
      const row = state.readRows()[0]!
      const cells = row.cells.map((cell) => ({ ...cell, style: { ...cell.style! } }))
      let blinkReads = 0
      for (const cell of cells) {
        Object.defineProperty(cell.style, 'blink', {
          get() {
            blinkReads++
            return false
          },
        })
      }
      const runs = renderRowRuns({ ...row, cells }, undefined, probeFont, theme)
      const comparisonReads = blinkReads
      expect(cells[0]!.style === cells[1]!.style).toBe(false)
      expect(runs.map((run) => run.text)).toEqual(['ABCD'])
      expect(comparisonReads).toBe(6)
    } finally {
      runtime.dispose()
    }
  })

  it('reprojects mutable cell text and colors without changing earlier runs', async () => {
    const runtime = await GhosttyRuntime.create()
    try {
      const terminal = runtime.createTerminal({ columns: 4, rows: 1 })
      const state = runtime.createRenderState(terminal)
      terminal.write('\x1b[?25lABCD')
      state.update()
      const row = state.readRows()[0]!
      const cells = row.cells.map((cell) => ({
        ...cell,
        foreground: { r: 10, g: 20, b: 30 },
        background: { r: 40, g: 50, b: 60 },
      }))
      const before = renderRowRuns({ ...row, cells }, undefined, probeFont, theme)
      cells[1]!.foreground.r = 90
      cells[1]!.background.b = 70
      cells[1]!.text = '<&"'
      const after = renderRowRuns({ ...row, cells }, undefined, probeFont, theme)
      expect(before.map((run) => run.text)).toEqual(['ABCD'])
      expect(before[0]!.style).toContain('color:rgb(10, 20, 30);')
      expect(before[0]!.style).toContain('background-color:rgb(40, 50, 60);')
      expect(after.map((run) => run.text)).toEqual(['A', '<&"', 'CD'])
      expect(after[1]!.style).toContain('color:rgb(90, 20, 30);')
      expect(after[1]!.style).toContain('background-color:rgb(40, 50, 70);')
    } finally {
      runtime.dispose()
    }
  })

  it('reprojects a shared mutable style after it changes between calls', async () => {
    const runtime = await GhosttyRuntime.create()
    try {
      const terminal = runtime.createTerminal({ columns: 4, rows: 1 })
      const state = runtime.createRenderState(terminal)
      terminal.write('\x1b[?25l\x1b[1mABCD')
      state.update()
      const row = state.readRows()[0]!
      const style = { ...row.cells[0]!.style! }
      const cells = row.cells.map((cell) => ({ ...cell, style }))
      const before = renderRowRuns({ ...row, cells }, undefined, probeFont, theme)
      style.bold = false
      style.italic = true
      const after = renderRowRuns({ ...row, cells }, undefined, probeFont, theme)
      expect(before[0]!.style).toContain('font-weight:700;')
      expect(before[0]!.style).toContain('font-style:normal;')
      expect(after[0]!.style).toContain('font-weight:400;')
      expect(after[0]!.style).toContain('font-style:italic;')
      expect(after.map((run) => run.text)).toEqual(['ABCD'])
      expect(before[0]!.style).toContain('font-weight:700;')
    } finally {
      runtime.dispose()
    }
  })

  it.each([
    'blink',
    'bold',
    'faint',
    'invisible',
    'inverse',
    'italic',
    'overline',
    'strikethrough',
    'underline',
  ] as const)('keeps the structural %s comparison for distinct styles', async (field) => {
    const runtime = await GhosttyRuntime.create()
    const foreground = vi.spyOn(CanvasColorCache.prototype, 'foreground')
    try {
      const terminal = runtime.createTerminal({ columns: 4, rows: 1 })
      const state = runtime.createRenderState(terminal)
      terminal.write('\x1b[?25l\x1b[1mABCD')
      state.update()
      const row = state.readRows()[0]!
      const style: CellStyle = { ...row.cells[0]!.style!, bold: false }
      const changed: CellStyle = { ...style, [field]: field === 'underline' ? 2 : true }
      const cells = row.cells.map((cell, index) => ({
        ...cell,
        style: { ...(index === 1 || index === 2 ? changed : style) },
      }))
      renderRowRuns({ ...row, cells }, undefined, probeFont, theme)
      expect(foreground).toHaveBeenCalledTimes(3)
    } finally {
      foreground.mockRestore()
      runtime.dispose()
    }
  })

  it('checks foreground presence while undefined styles share a reference', async () => {
    const runtime = await GhosttyRuntime.create()
    const foreground = vi.spyOn(CanvasColorCache.prototype, 'foreground')
    try {
      const terminal = runtime.createTerminal({ columns: 4, rows: 1 })
      const state = runtime.createRenderState(terminal)
      terminal.write('\x1b[?25lABCD')
      state.update()
      const row = state.readRows()[0]!
      const cells = row.cells.map((cell, index) => ({
        ...cell,
        foreground: index === 1 || index === 2 ? { ...theme.foreground } : undefined,
      }))
      renderRowRuns({ ...row, cells }, undefined, probeFont, theme)
      expect(foreground).toHaveBeenCalledTimes(3)
    } finally {
      foreground.mockRestore()
      runtime.dispose()
    }
  })

  it.each([
    ['foreground', 'r'],
    ['foreground', 'g'],
    ['foreground', 'b'],
    ['background', 'r'],
    ['background', 'g'],
    ['background', 'b'],
  ] as const)(
    'compares %s channel %s values across separate color objects',
    async (field, channel) => {
      const runtime = await GhosttyRuntime.create()
      const foreground = vi.spyOn(CanvasColorCache.prototype, 'foreground')
      try {
        const terminal = runtime.createTerminal({ columns: 4, rows: 1 })
        const state = runtime.createRenderState(terminal)
        terminal.write('\x1b[?25lABCD')
        state.update()
        const row = state.readRows()[0]!
        const cells = row.cells.map((cell, index) => ({
          ...cell,
          [field]: { r: 20, g: 30, b: 40, [channel]: index === 1 || index === 2 ? 90 : 10 },
        }))
        const runs = renderRowRuns({ ...row, cells }, undefined, probeFont, theme)
        expect(cells[1]![field]).not.toBe(cells[2]![field])
        expect(runs.map((run) => run.text)).toEqual(['A', 'BC', 'D'])
        expect(foreground).toHaveBeenCalledTimes(3)
      } finally {
        foreground.mockRestore()
        runtime.dispose()
      }
    },
  )

  it('preserves explicit background presence even when its value matches the theme', async () => {
    const runtime = await GhosttyRuntime.create()
    try {
      const terminal = runtime.createTerminal({ columns: 4, rows: 1 })
      const state = runtime.createRenderState(terminal)
      terminal.write('\x1b[?25lABCD')
      state.update()
      const row = state.readRows()[0]!
      const cells = row.cells.map((cell, index) => ({
        ...cell,
        background: index === 1 || index === 2 ? { ...theme.background } : undefined,
      }))
      const runs = renderRowRuns({ ...row, cells }, undefined, probeFont, theme)
      expect(runs.map((run) => run.text)).toEqual(['A', 'BC', 'D'])
      expect(runs[0]!.style).not.toContain('background-color:')
      expect(runs[1]!.style).toContain('background-color:rgb(17, 17, 17);')
    } finally {
      runtime.dispose()
    }
  })

  it.each(['block', 'bar', 'outline', 'underline'] as const)(
    'isolates %s cursors and wide continuations',
    async (style) => {
      const runtime = await GhosttyRuntime.create()
      const foreground = vi.spyOn(CanvasColorCache.prototype, 'foreground')
      try {
        const terminal = runtime.createTerminal({ columns: 6, rows: 1 })
        const state = runtime.createRenderState(terminal)
        terminal.write('\x1b[?25lA界BCD')
        state.update()
        const row = state.readRows()[0]!
        const runs = renderRowRuns(row, { style, visible: true, x: 4, y: 0 }, probeFont, theme)
        expect(runs.map((run) => run.text)).toEqual(['A', '界', 'B', 'C', 'D'])
        expect(runs[1]!.style).toContain('text-align:center;')
        expect(runs[1]!.style).toContain('width:calc(2 * var(--ghostty-cell-width, 10px));')
        expect(runs[3]!.cursor).toBe(style)
        expect(foreground).toHaveBeenCalledTimes(5)
      } finally {
        foreground.mockRestore()
        runtime.dispose()
      }
    },
  )
})

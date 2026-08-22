import { afterEach, describe, expect, it } from 'vitest'
import { RenderStateDirty } from '../abi.js'
import { GhosttyRuntime } from '../runtime.js'
import type { RenderRow } from '../types.js'

const decoder = new TextDecoder()
let runtime: GhosttyRuntime | undefined

afterEach(() => {
  runtime?.dispose()
  runtime = undefined
})

function rowText(row: RenderRow): string {
  return row.cells.map((cell) => cell.text || ' ').join('')
}

describe('libghostty-vt callback bridge', () => {
  it('handles pointer, out-struct, and sret callback shapes', async () => {
    runtime = await GhosttyRuntime.create()
    const writes: Uint8Array[] = []
    let titleChanges = 0
    const terminal = runtime.createTerminal({
      columns: 80,
      rows: 24,
      effects: {
        titleChanged: () => {
          titleChanges += 1
        },
        writePty: (bytes) => writes.push(bytes),
        xtversion: 'ghostty-webgpu-test',
      },
    })

    terminal.write('\u001b[c')
    terminal.write('\u001b[>q')
    terminal.write('\u001b[18t')
    terminal.write('\u001b]0;bridge-title\u0007')

    const output = decoder.decode(Buffer.concat(writes))
    expect(output).toContain('\u001b[?62;1;6;22c')
    expect(output).toContain('ghostty-webgpu-test')
    expect(output).toContain('\u001b[8;24;80t')
    expect(titleChanges).toBe(1)
    expect(terminal.title).toBe('bridge-title')
    terminal.dispose()
  })

  it('enforces process-global PNG setup before terminals exist', async () => {
    runtime = await GhosttyRuntime.create({
      decodePng: () => ({
        height: 1,
        pixels: new Uint8Array([12, 34, 56, 255]),
        width: 1,
      }),
    })
    const terminal = runtime.createTerminal()

    expect(() => runtime?.configurePngDecoder(undefined)).toThrow(
      'PNG decoding must be configured before the first terminal is created',
    )
    terminal.dispose()
    expect(() => runtime?.configurePngDecoder(undefined)).not.toThrow()
  })
})

describe('VT corpus rendering', () => {
  it.each([
    {
      input: 'first\r\nsecond',
      name: 'line controls',
      verify(rows: readonly RenderRow[]) {
        expect(rowText(rows[0]!)).toBe('first   ')
        expect(rowText(rows[1]!)).toBe('second  ')
      },
    },
    {
      input: 'e\u0301界',
      name: 'combining and wide graphemes',
      verify(rows: readonly RenderRow[]) {
        expect(rows[0]?.cells[0]?.text).toBe('e\u0301')
        expect(rows[0]?.cells[1]?.text).toBe('界')
        expect(rows[0]?.cells[2]?.text).toBe('')
      },
    },
    {
      input: '\u001b[2;3HX',
      name: 'cursor positioning',
      verify(rows: readonly RenderRow[]) {
        expect(rows[1]?.cells[2]?.text).toBe('X')
      },
    },
    {
      input: '\u001b[31;1;4mR\u001b[0m',
      name: 'SGR color and decorations',
      verify(rows: readonly RenderRow[]) {
        const cell = rows[0]?.cells[0]
        expect(cell?.text).toBe('R')
        expect(cell?.foreground).toEqual({ b: 102, g: 102, r: 204 })
        expect(cell?.style?.bold).toBe(true)
        expect(cell?.style?.underline).toBe(1)
      },
    },
  ])('maps $name into render-state cells', async ({ input, verify }) => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 8, rows: 3 })
    const renderState = runtime.createRenderState(terminal)
    terminal.write(input)

    const snapshot = renderState.snapshot()

    expect(snapshot.dirty).toBe(RenderStateDirty.Full)
    verify(snapshot.rows)
    renderState.dispose()
    terminal.dispose()
  })
})

describe('damage acknowledgement', () => {
  it('clears global and row damage and preserves targeted re-damage', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 10, rows: 3 })
    const renderState = runtime.createRenderState(terminal)

    expect(renderState.update()).toBe(RenderStateDirty.Full)
    expect(renderState.readRows({ dirtyOnly: true })).toHaveLength(3)
    expect(renderState.acknowledge()).toBe(3)
    expect(renderState.update()).toBe(RenderStateDirty.False)

    terminal.write('X')

    expect(renderState.update()).toBe(RenderStateDirty.Partial)
    const changedRows = renderState.readRows({ dirtyOnly: true })
    expect(changedRows).toHaveLength(1)
    expect(changedRows[0]?.y).toBe(0)
    expect(changedRows[0]?.cells[0]?.text).toBe('X')
    expect(renderState.acknowledge()).toBe(1)
    expect(renderState.update()).toBe(RenderStateDirty.False)
    renderState.dispose()
    terminal.dispose()
  })
})

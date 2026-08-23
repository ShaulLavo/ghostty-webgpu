import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { ClipboardLocation, ClipboardWriteResult, ColorScheme, RenderStateDirty } from '../abi.js'
import { GhosttyRuntime } from '../runtime.js'
import type { ClipboardWrite, RenderRow } from '../types.js'

const decoder = new TextDecoder()
let runtime: GhosttyRuntime | undefined

afterEach(() => {
  runtime?.dispose()
  runtime = undefined
})

function rowText(row: RenderRow): string {
  return row.cells.map((cell) => cell.text || ' ').join('')
}

async function wasmWithRenamedExport(name: string): Promise<Uint8Array> {
  const bytes = await readFile(new URL('../../../ghostty-vt.wasm', import.meta.url))
  const exportedName = Buffer.from(`${name}\0`)
  const offset = bytes.indexOf(exportedName)
  if (offset < 0) throw new TypeError(`Wasm export is missing from the test artifact: ${name}`)
  bytes[offset + name.length - 1] = 'x'.charCodeAt(0)
  return bytes
}

describe('runtime export validation', () => {
  it('rejects a wasm module without the required cell accessor', async () => {
    const wasm = await wasmWithRenamedExport('ghostty_cell_get')

    await expect(GhosttyRuntime.create({ wasm })).rejects.toThrow(
      'libghostty-vt export is missing: ghostty_cell_get',
    )
  })
})

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

  it('dispatches bell and reports the configured color scheme', async () => {
    runtime = await GhosttyRuntime.create()
    const writes: Uint8Array[] = []
    let bellCount = 0
    const terminal = runtime.createTerminal({
      effects: {
        bell: () => {
          bellCount += 1
        },
        colorScheme: ColorScheme.Dark,
        writePty: (bytes) => writes.push(bytes),
      },
    })

    terminal.write('\u0007\u001b[?996n')

    expect(bellCount).toBe(1)
    expect(decoder.decode(Buffer.concat(writes))).toBe('\u001b[?997;1n')
    terminal.dispose()
  })

  it('copies OSC 52 clipboard content before the callback returns', async () => {
    runtime = await GhosttyRuntime.create()
    const clipboardWrites: ClipboardWrite[] = []
    const terminal = runtime.createTerminal({
      effects: {
        clipboardWrite: (write) => {
          clipboardWrites.push(write)
          return ClipboardWriteResult.Success
        },
      },
    })

    terminal.write('\u001b]52;c;Y29waWVkIGNvbnRlbnQ=\u0007')

    const first = clipboardWrites[0]!
    const firstContent = first.contents[0]!
    expect(first.location).toBe(ClipboardLocation.Standard)
    expect(firstContent.mime).toBe('text/plain')
    expect(decoder.decode(firstContent.data)).toBe('copied content')
    expect(firstContent.data.buffer).not.toBe(runtime.exports.memory.buffer)

    terminal.write('\u001b]52;c;cmVwbGFjZW1lbnQ=\u0007')

    expect(clipboardWrites).toHaveLength(2)
    expect(decoder.decode(firstContent.data)).toBe('copied content')
    terminal.dispose()
  })

  it('denies clipboard writes when no effect is configured', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal()
    const callback = runtime.bridge.imports.env?.clipboard_write

    expect(callback).toBeTypeOf('function')
    if (typeof callback !== 'function') return
    expect(callback(terminal.handle, 0, 0)).toBe(ClipboardWriteResult.Denied)
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
        expect(rows[0]?.cells[0]?.continuation).toBe(false)
        expect(rows[0]?.cells[1]?.continuation).toBe(false)
        expect(rows[0]?.cells[2]?.continuation).toBe(true)
        expect(rows[0]?.cells[3]?.continuation).toBe(false)
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

  it('distinguishes a wrapped wide spacer head from its continuation tail', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 2, rows: 2 })
    const renderState = runtime.createRenderState(terminal)
    terminal.write('A界')

    const rows = renderState.snapshot().rows

    expect(rows[0]?.cells[1]).toMatchObject({ continuation: false, text: '' })
    expect(rows[1]?.cells[0]).toMatchObject({ continuation: false, text: '界' })
    expect(rows[1]?.cells[1]).toMatchObject({ continuation: true, text: '' })
    renderState.dispose()
    terminal.dispose()
  })

  it('reads terminal-driven cursor state as one render snapshot', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 4, rows: 2 })
    const renderState = runtime.createRenderState(terminal)

    const cursorStyles = [
      { blinking: true, sequence: 1, style: 'block' },
      { blinking: false, sequence: 2, style: 'block' },
      { blinking: true, sequence: 3, style: 'underline' },
      { blinking: false, sequence: 4, style: 'underline' },
      { blinking: true, sequence: 5, style: 'bar' },
      { blinking: false, sequence: 6, style: 'bar' },
    ] as const
    for (const expected of cursorStyles) {
      terminal.write(`\u001b[${expected.sequence} q`)
      renderState.update()
      expect(renderState.readCursor()).toMatchObject({
        blinking: expected.blinking,
        style: expected.style,
      })
    }

    terminal.write('\u001b[3 q\u001b[2;3H')
    renderState.update()
    expect(renderState.readCursor()).toEqual({
      blinking: true,
      passwordInput: false,
      style: 'underline',
      viewport: { wideTail: false, x: 2, y: 1 },
      visible: true,
    })

    terminal.write('\u001b[5 q\u001b[?25l')
    renderState.update()
    expect(renderState.readCursor()).toMatchObject({
      blinking: true,
      style: 'bar',
      visible: false,
    })

    terminal.setDefaultCursorStyle('outline')
    terminal.reset()
    renderState.update()
    expect(renderState.readCursor().style).toBe('outline')

    terminal.write('a\r\nb\r\nc')
    terminal.scrollToTop()
    renderState.update()
    expect(renderState.readCursor().viewport).toBeUndefined()
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

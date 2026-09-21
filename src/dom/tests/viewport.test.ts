import { describe, expect, it } from 'vitest'
import { defaultRendererTheme } from '../../render/instances/types.js'
import { encodeTerminalViewport, TERMINAL_VIEWPORT_MAX_BYTES } from '../viewport.js'

function input() {
  return {
    width: 400,
    height: 100,
    columns: 40,
    scrollbar: { offset: 0, length: 1, total: 1 },
    rows: [
      {
        y: 0,
        dirty: false,
        cells: [{ x: 0, text: 'saved', continuation: false, selected: false }],
      },
    ],
    cursor: {
      blinking: false,
      passwordInput: false,
      style: 'outline' as const,
      visible: true,
      viewport: { x: 5, y: 0, wideTail: false },
    },
    font: {
      charLeft: 0,
      charTop: 0,
      cssCellHeight: 20,
      cssCellWidth: 10,
      deviceBaseline: 15,
      deviceCellHeight: 20,
      deviceCellWidth: 10,
      deviceCharHeight: 20,
      deviceCharWidth: 10,
      pixelRatio: 1,
      settings: {
        family: 'monospace',
        size: 16,
        weight: 400,
        boldWeight: 700,
        letterSpacing: 0,
        lineHeight: 1,
      },
    },
    theme: defaultRendererTheme,
    padding: { top: 0, bottom: 0, left: 0, right: 0 },
  }
}

describe('bounded viewport capture', () => {
  it('does not capture password input', () => {
    const frame = input()
    expect(encodeTerminalViewport(frame)).toBeDefined()
    frame.cursor.passwordInput = true
    expect(encodeTerminalViewport(frame)).toBeUndefined()
  })

  it('rejects oversized cells and excessive drawable area before admission', () => {
    const frame = input()
    frame.rows[0]!.cells[0]!.text = 'x'.repeat(TERMINAL_VIEWPORT_MAX_BYTES)
    expect(encodeTerminalViewport(frame)).toBeUndefined()
    frame.rows[0]!.cells[0]!.text = 'saved'
    frame.font.deviceCellWidth = 16384
    expect(encodeTerminalViewport(frame)).toBeUndefined()
  })

  it('stops packing at the aggregate budget before reading later cells', () => {
    const frame = input()
    frame.rows[0]!.cells = Array.from({ length: 40 }, (_, x) => ({
      x,
      text: 'x'.repeat(4096),
      continuation: false,
      selected: false,
    }))
    Object.defineProperty(frame.rows[0]!.cells[39], 'text', {
      get: () => {
        throw new Error('Packing continued after exhausting the byte budget')
      },
    })
    expect(encodeTerminalViewport(frame)).toBeUndefined()
  })

  it('omits default blank cells from the bounded presentation', () => {
    const frame = input()
    frame.rows[0]!.cells = Array.from({ length: 40 }, (_, x) => ({
      x,
      text: '',
      continuation: false,
      selected: false,
    }))
    const snapshot = encodeTerminalViewport(frame)
    expect(snapshot).toContain('"rows":[[]]')
    expect(snapshot!.length * 2).toBeLessThan(2048)
  })
})

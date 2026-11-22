import { expect, test } from 'vitest'
import { calculateTerminalFittedFont } from '../dom/fit.js'
import { submittedFrame, type TerminalSubmittedSnapshot } from '../dom/submitted-frame.js'
import type { RendererTextFrameRow, RendererTextFrameSnapshot } from '../render/shared/types.js'
import { defaultRendererTheme } from '../term/theme.js'
import { RowDeltaDecoder, RowDeltaEncoder } from './frame-codec.js'
import type { WorkerFrameDelta } from './protocol.js'

const font = calculateTerminalFittedFont(
  { boldWeight: 700, family: 'test', letterSpacing: 0, lineHeight: 1, size: 14, weight: 400 },
  { advanceWidth: 8, fontAscent: 10, fontDescent: 3 },
  2,
)

function row(y: number, text: string): RendererTextFrameRow {
  return { y, text, cells: [text], continuations: [false] }
}

function transport() {
  const encoder = new RowDeltaEncoder()
  const decoder = new RowDeltaDecoder()
  let previous: TerminalSubmittedSnapshot | undefined
  return {
    decoder,
    send(rows: readonly RendererTextFrameRow[], layout = 1) {
      const snapshot: RendererTextFrameSnapshot = {
        renderHeld: false,
        cursor: {
          blinking: false,
          passwordInput: false,
          style: 'bar',
          visible: true,
          viewport: { x: 3, y: 0, wideTail: false },
        },
        paintedCursor: { x: 3, y: 0, visible: true, style: 'bar' },
        rows,
      }
      const frame = (previous?.frame ?? 0) + 1
      const summary = submittedFrame(previous, {
        nativeRevision: frame,
        snapshotVersion: frame,
        layout,
        grid: {
          rows: rows.length,
          columns: 8,
          cellWidth: font.cssCellWidth,
          cellHeight: font.cssCellHeight,
          pixelRatio: font.pixelRatio,
        },
        font,
        padding: { top: 1, right: 2, bottom: 3, left: 4 },
        theme: defaultRendererTheme,
        selection: { start: { x: 0, y: 0 }, end: { x: 3, y: 0 }, rectangle: false },
        scrollbar: { length: rows.length, offset: 0, total: rows.length },
        snapshot,
      })
      previous = summary
      const encoded = encoder.encode({
        type: 'frame',
        terminal: 'test',
        generation: 1,
        control: frame,
        output: frame - 1,
        base: frame - 1,
        mouseTracking: false,
        snapshot,
        summary,
      })
      const message = structuredClone(encoded, { transfer: [encoded.buffer] })
      expect(encoded.buffer.byteLength).toBe(0)
      return { message, snapshot, summary }
    },
  }
}

function changedRows(message: WorkerFrameDelta): number {
  return new DataView(message.buffer).getUint32(0, true)
}

test('transfers a full frame with exact UTF-16 text, cells, flags, and metadata', () => {
  const { send, decoder } = transport()
  const cells = ['\ufeff', '界', '', 'e\u0301', '👨‍💻', '\ud800', '\udc00', '', '🧪']
  const continuations = [false, false, true, false, false, false, false, false, false]
  const longCell = 'α'.repeat(4095) + '🧪' + 'β'.repeat(4096)
  const rows = [
    { y: 0, text: cells.join(' '), cells, continuations },
    { y: 1, text: longCell, cells: [longCell, ''], continuations: [false, false] },
  ]
  const { message, snapshot, summary } = send(rows)
  expect(changedRows(message)).toBe(2)
  expect(message.order).toEqual([0, 1])
  expect(message.patches).toEqual([0, 1])
  expect(message.snapshot).not.toHaveProperty('rows')
  expect(message.summary).not.toHaveProperty('rowPatches')
  expect(decoder.decode(message)).toEqual({
    type: 'frame',
    terminal: 'test',
    generation: 1,
    control: 1,
    output: 0,
    base: 0,
    mouseTracking: false,
    snapshot,
    summary,
  })
})

test('packs continuation flags at one byte per cell', () => {
  const { send, decoder } = transport()
  const cells = Array.from({ length: 100 }, () => '')
  const continuations = Array.from({ length: cells.length }, (_, index) => index % 2 === 1)
  const { message } = send([{ y: 0, text: '', cells, continuations }])
  expect(message.buffer.byteLength).toBe(4 + 16 + cells.length * 5)
  expect(decoder.decode(message).snapshot.rows[0]?.continuations).toEqual(continuations)
})

test('sends one changed row and retains unchanged frozen rows and prior snapshots', () => {
  const { send, decoder } = transport()
  const first = send([row(0, 'hello'), row(1, 'stable')])
  const old = decoder.decode(first.message)
  const second = send([row(0, 'hello!'), row(1, 'stable')])
  const next = decoder.decode(second.message)
  expect(changedRows(second.message)).toBe(1)
  expect(second.message.buffer.byteLength).toBeLessThan(first.message.buffer.byteLength)
  expect(second.message.patches).toEqual([0])
  expect(next.snapshot).toEqual(second.snapshot)
  expect(next.summary).toEqual(second.summary)
  expect(next.snapshot.rows[1]).toBe(old.snapshot.rows[1])
  expect(next.summary.rows[1]).toBe(old.summary.rows[1])
  expect(next.summary.rowPatches[0]).toBe(next.summary.rows[0])
  const frozen = [
    old.snapshot,
    old.snapshot.rows,
    old.snapshot.rows[0],
    old.snapshot.rows[0]?.cells,
    old.snapshot.rows[0]?.continuations,
    old.snapshot.cursor.viewport,
    old.summary,
    old.summary.rows,
    old.summary.rows[0],
    old.summary.rowPatches,
    old.summary.font.settings,
    old.summary.selection?.start,
  ]
  for (const value of frozen) {
    expect(value).toBeDefined()
    expect(Object.isFrozen(value)).toBe(true)
  }
  expect(old.snapshot).toEqual(first.snapshot)
  expect(old.summary).toEqual(first.summary)
})

test('sends cell or flag changes even when the summary has no text patches', () => {
  const { send, decoder } = transport()
  const first = { y: 0, text: 'ab', cells: ['a', 'b'], continuations: [false, false] }
  let previous = decoder.decode(send([first]).message)
  const cellChange = { ...first, cells: ['ab', ''] }
  for (const changed of [cellChange, { ...cellChange, continuations: [false, true] }]) {
    const { message } = send([changed])
    expect(changedRows(message)).toBe(1)
    expect(message.patches).toEqual([])
    const next = decoder.decode(message)
    expect(next.snapshot.rows[0]).toEqual(changed)
    expect(next.summary.rows[0]).toBe(previous.summary.rows[0])
    previous = next
  }
})

test('rebuilds scrolled rows in viewport order and retains layout-only patches', () => {
  const { send, decoder } = transport()
  decoder.decode(send([row(0, 'one'), row(1, 'two'), row(2, 'three')]).message)
  const shifted = [row(0, 'two'), row(1, 'three'), row(2, 'four')]
  const scroll = send(shifted)
  expect(changedRows(scroll.message)).toBe(3)
  expect(decoder.decode(scroll.message).snapshot.rows).toEqual(shifted)
  const layout = send(shifted, 2)
  expect(changedRows(layout.message)).toBe(0)
  expect(layout.message.patches).toEqual([0, 1, 2])
  expect(decoder.decode(layout.message).summary).toEqual(layout.summary)
})

test('re-encodes rows after a resize or empty frame evicts them', () => {
  const { send, decoder } = transport()
  const largeRows = [row(0, 'top'), row(1, 'middle'), row(2, 'bottom')]
  const smallRows = largeRows.slice(0, 1)
  for (const [rows, count] of [
    [largeRows, 3],
    [smallRows, 0],
    [largeRows, 2],
    [[], 0],
    [largeRows, 3],
  ] as const) {
    const { message, summary } = send(rows)
    expect(changedRows(message)).toBe(count)
    if (count === 0) expect(message.buffer.byteLength).toBe(4)
    if (count === 2) {
      const missing = { ...message, buffer: new ArrayBuffer(4) }
      expect(() => decoder.decode(missing)).toThrow('Invalid row order at 1')
    }
    const decoded = decoder.decode(message)
    expect(decoded.snapshot.rows).toEqual(rows)
    expect(decoded.summary).toEqual(summary)
  }
})

test('rejects truncated buffers, trailing bytes, invalid lengths, and missing rows', () => {
  const { send, decoder } = transport()
  const { message } = send([row(0, 'a')])
  const { buffer } = message
  const trailing = new ArrayBuffer(buffer.byteLength + 2)
  new Uint8Array(trailing).set(new Uint8Array(buffer))
  const invalidLength = buffer.slice(0)
  new DataView(invalidLength).setUint32(12, 0xffffffff, true)
  const invalidFlag = buffer.slice(0)
  new Uint8Array(invalidFlag)[invalidFlag.byteLength - 2] = 2
  for (const malformed of [
    { ...message, buffer: buffer.slice(0, -2) },
    { ...message, buffer: trailing },
    { ...message, buffer: invalidLength },
    { ...message, buffer: invalidFlag },
    { ...message, order: [1] },
    { ...message, order: [0, 0] },
    { ...message, patches: [1] },
  ]) {
    expect(() => decoder.decode(malformed)).toThrow()
  }
  expect(decoder.decode(message).snapshot.rows).toEqual([row(0, 'a')])
})

test('reset clears the decoder row cache', () => {
  const { send, decoder } = transport()
  decoder.decode(send([row(0, 'old')]).message)
  decoder.reset()
  const { message } = send([row(0, 'old')])
  expect(changedRows(message)).toBe(0)
  expect(() => decoder.decode(message)).toThrow('Invalid row order at 0')
})

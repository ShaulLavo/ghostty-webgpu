import { expect, test } from 'bun:test'
import { LocalTerminalExecution } from '../../src/dom/execution-local.js'
import { calculateTerminalFittedFont } from '../../src/dom/fit.js'
import type {
  RendererTextFrameRow,
  RendererTextFrameSnapshot,
} from '../../src/render/shared/types.js'
import type { WorkerMessage } from '../../src/worker/protocol.js'
import { freezeWorkerValue } from '../../src/worker/owned.js'
import { RowEncoder, RowDecoder } from './codec.js'
import { Reception } from './transport.js'

async function execution(rows = 2): Promise<LocalTerminalExecution> {
  const value = await LocalTerminalExecution.create({
    appearance: { grid: { columns: 8, rows } },
  })
  value.commitLayout(
    calculateTerminalFittedFont(
      value.appearance.font,
      { advanceWidth: 8, fontAscent: 10, fontDescent: 3 },
      2,
    ),
    { top: 1, right: 2, bottom: 3, left: 4 },
  )
  return value
}

function frame(
  execution: LocalTerminalExecution,
  terminal: string,
  rows: readonly RendererTextFrameRow[],
): Extract<WorkerMessage, { type: 'frame' }> {
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
  execution.submit(snapshot)
  const summary = execution.submittedFrame
  if (!summary) throw new Error('missing submission')
  return {
    type: 'frame',
    terminal,
    generation: 1,
    control: summary.frame,
    output: 0,
    base: summary.frame - 1,
    mouseTracking: false,
    snapshot,
    summary,
  }
}

function row(y: number, text: string): RendererTextFrameRow {
  return { y, text, cells: [text], continuations: [false] }
}

test('revision payloads preserve cell boundaries, continuations, metadata and retained ownership', async () => {
  const execution = await LocalTerminalExecution.create({
    appearance: { grid: { columns: 8, rows: 2 } },
  })
  try {
    execution.commitLayout(
      calculateTerminalFittedFont(
        execution.appearance.font,
        { advanceWidth: 8, fontAscent: 10, fontDescent: 3 },
        2,
      ),
      { top: 1, right: 2, bottom: 3, left: 4 },
    )
    execution.write('abc def\r\nsecond')
    execution.selectRange({ x: 0, y: 0 }, { x: 3, y: 0 })
    const encoder = new RowEncoder()
    const decoder = new RowDecoder()
    const retained: RendererTextFrameSnapshot[] = []
    const originals: RendererTextFrameSnapshot[] = []
    const cells = ['A', '界', '', 'é', '𝑓', '🧪', '\ud800', '']
    const original = {
      y: 0,
      text: cells.join(''),
      cells,
      continuations: [false, false, true, false, false, false, false, false],
    }
    const variants = [
      original,
      { ...original, cells: ['A界', '', '', 'é', '𝑓', '🧪', '\ud800', ''] },
      { ...original, continuations: [false, true, false, false, false, false, false, false] },
      original,
    ]
    for (const [index, variant] of variants.entries()) {
      if (retained.length === 2) execution.clearSelection()
      const message = frame(execution, 'test', [variant, row(1, 'stable')])
      const encoded = encoder.encode(message, [index + 1, 20])
      const decoded = freezeWorkerValue(
        decoder.decode(structuredClone(encoded, { transfer: [encoded.buffer] })),
      )
      expect(decoded.snapshot).toEqual(message.snapshot)
      expect(decoded.summary).toEqual(message.summary)
      expect(Object.isFrozen(decoded.snapshot.rows[0]?.cells)).toBe(true)
      expect(Object.isFrozen(decoded.summary.font.settings)).toBe(true)
      retained.push(decoded.snapshot)
      originals.push(structuredClone(message.snapshot))
    }
    expect(retained).toEqual(originals)
    expect(retained[0]?.rows[1]).toBe(retained[3]?.rows[1])
    expect(retained[0]?.rows[0]).not.toBe(retained[1]?.rows[0])
  } finally {
    execution.dispose()
  }
})

test('a moved revision sends only the new row and keeps older snapshots readable', async () => {
  const context = await execution()
  const encoder = new RowEncoder()
  const decoder = new RowDecoder()
  try {
    const first = frame(context, 'test', [row(0, 'first'), row(1, 'second')])
    const second = frame(context, 'test', [row(0, 'second'), row(1, 'third')])
    const firstPacket = encoder.encode(first, [1, 2])
    const firstDecoded = decoder.decode(firstPacket)
    const secondPacket = encoder.encode(second, [2, 3])
    expect(new DataView(secondPacket.buffer).getUint32(0, true)).toBe(1)
    const secondDecoded = decoder.decode(secondPacket)
    expect(secondDecoded.snapshot.rows[0]?.text).toBe('second')
    expect(secondDecoded.snapshot.rows[0]?.cells).toBe(firstDecoded.snapshot.rows[1]?.cells)
    expect(secondDecoded.summary).toEqual(second.summary)
    expect(firstDecoded.snapshot.rows.map((value) => value.text)).toEqual(['first', 'second'])
    const repeated = frame(context, 'test', [row(0, 'second'), row(1, 'third')])
    const repeatedPacket = encoder.encode(repeated, [2, 3])
    expect(new DataView(repeatedPacket.buffer).getUint32(0, true)).toBe(0)
    const repeatedDecoded = decoder.decode(repeatedPacket)
    expect(repeatedDecoded.snapshot.rows[0]).toBe(secondDecoded.snapshot.rows[0])
  } finally {
    context.dispose()
  }
})

test('interleaved terminals retain independent revision caches through Reception', async () => {
  const context = await execution(1)
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { __deltaBytes: 0, __deltaTimings: [] },
  })
  try {
    const reception = new Reception(true)
    const firstEncoder = new RowEncoder()
    const secondEncoder = new RowEncoder()
    const received: Extract<WorkerMessage, { type: 'frame' }>[] = []
    const send = (encoder: RowEncoder, terminal: string, text: string, changedRows: number) => {
      const message = frame(context, terminal, [row(0, text)])
      const packet = encoder.encode(message, [1])
      expect(new DataView(packet.buffer).getUint32(0, true)).toBe(changedRows)
      reception.receive(
        {
          ...structuredClone(packet, { transfer: [packet.buffer] }),
          experimentTiming: {
            terminal,
            control: message.control,
            kind: 'frame',
            at: performance.now(),
          },
        },
        (decoded) => {
          if (decoded.type !== 'frame') throw new Error('expected frame')
          received.push(freezeWorkerValue(decoded))
        },
      )
      const latest = received.at(-1)
      expect(latest?.snapshot).toEqual(message.snapshot)
      expect(latest?.summary).toEqual(message.summary)
    }
    send(firstEncoder, 'first', 'first row', 1)
    send(secondEncoder, 'second', 'second row', 1)
    send(firstEncoder, 'first', 'first row', 0)
    send(secondEncoder, 'second', 'second row', 0)
    expect(received[0]?.snapshot.rows[0]).toBe(received[2]?.snapshot.rows[0])
    expect(received[1]?.snapshot.rows[0]).toBe(received[3]?.snapshot.rows[0])
    expect(received[0]?.snapshot.rows[0]).not.toBe(received[1]?.snapshot.rows[0])
  } finally {
    context.dispose()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

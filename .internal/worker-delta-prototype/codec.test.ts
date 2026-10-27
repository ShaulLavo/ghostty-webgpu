import { expect, test } from 'bun:test'
import { LocalTerminalExecution } from '../../src/dom/execution-local.js'
import { calculateTerminalFittedFont } from '../../src/dom/fit.js'
import type { RendererTextFrameSnapshot } from '../../src/render/shared/types.js'
import type { WorkerMessage } from '../../src/worker/protocol.js'
import { freezeWorkerValue } from '../../src/worker/owned.js'
import { RowEncoder, RowDecoder } from './codec.js'

test('complete row deltas preserve cell boundaries, continuations, metadata and retained ownership', async () => {
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
    const encoder = new RowEncoder()
    const decoder = new RowDecoder()
    const retained: RendererTextFrameSnapshot[] = []
    const originals: RendererTextFrameSnapshot[] = []
    const cells = ['A', '界', '', 'e\u0301', '𝑓', '🧪', '\ud800', '']
    const row = {
      y: 0,
      text: cells.join(''),
      cells,
      continuations: [false, false, true, false, false, false, false, false],
    }
    const variants = [
      row,
      { ...row, cells: ['A界', '', '', 'e\u0301', '𝑓', '🧪', '\ud800', ''] },
      { ...row, continuations: [false, true, false, false, false, false, false, false] },
      row,
    ]
    for (const variant of variants) {
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
        rows: [variant, { y: 1, text: 'stable', cells: ['stable'], continuations: [false] }],
      }
      execution.submit(snapshot)
      const summary = execution.submittedFrame
      if (!summary) throw new Error('missing submission')
      const message: Extract<WorkerMessage, { type: 'frame' }> = {
        type: 'frame',
        terminal: 'test',
        generation: 1,
        control: summary.frame,
        output: 0,
        base: summary.frame - 1,
        mouseTracking: false,
        snapshot,
        summary,
      }
      const encoded = encoder.encode(message)
      const decoded = freezeWorkerValue(
        decoder.decode(structuredClone(encoded, { transfer: [encoded.buffer] })),
      )
      expect(decoded.snapshot).toEqual(snapshot)
      expect(decoded.summary).toEqual(summary)
      expect(Object.isFrozen(decoded.snapshot.rows[0]?.cells)).toBe(true)
      expect(Object.isFrozen(decoded.summary.font.settings)).toBe(true)
      retained.push(decoded.snapshot)
      originals.push(structuredClone(snapshot))
    }
    expect(retained).toEqual(originals)
    expect(retained[0]?.rows[1]).toBe(retained[3]?.rows[1])
    expect(retained[0]?.rows[0]).not.toBe(retained[1]?.rows[0])
  } finally {
    execution.dispose()
  }
})

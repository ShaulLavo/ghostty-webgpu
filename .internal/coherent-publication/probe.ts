// X7 attribution probe: per-frame cost of displayed publication steps on the real wasm, outside a browser.
import { GhosttyRuntime } from '../../src/core/runtime.js'
import { FrameObserver } from '../../src/render/shared/frame-observer.js'
import { observeDisplayedFrame } from '../../src/render/shared/displayed-frame.js'
import { submittedFrame, type TerminalSubmittedSnapshot } from '../../src/dom/submitted-frame.js'
import type { DisplayedTextFrame } from '../../src/render/shared/displayed-frame.js'

const columns = Number(process.env.COLUMNS_X ?? 200)
const rows = Number(process.env.ROWS_X ?? 50)
const frames = Number(process.env.FRAMES ?? 600)
const workload = process.env.WORKLOAD ?? 'dense'
const observers = process.env.OBSERVERS === 'on'

const runtime = await GhosttyRuntime.create()
const terminal = runtime.createTerminal({
  columns,
  rows,
  scrollback: 2000,
} as never)
const state = runtime.createRenderState(terminal)
const extracted = { liveTextRows: 0, displayedTextRows: 0, livePaintRows: 0 }
function counted(
  name: 'readTextRows' | 'readRetainedText' | 'readRows',
  key: keyof typeof extracted,
) {
  const bridge = runtime.bridge as unknown as Record<string, (...args: number[]) => number>
  const original = bridge[name]!.bind(bridge)
  bridge[name] = (...args: number[]) => {
    const result = original(...args)
    extracted[key] += runtime.memory.view.getUint32(args[6]! + 8, true)
    return result
  }
}
counted('readTextRows', 'liveTextRows')
counted('readRetainedText', 'displayedTextRows')
counted('readRows', 'livePaintRows')
const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu '
function line(seed: number): string {
  let text = ''
  while (text.length < columns) text += words.slice(seed % 11) + seed + ' '
  return text.slice(0, columns)
}
function advance(frame: number): void {
  if (workload === 'dense') {
    let out = '\x1b[H'
    for (let y = 0; y < rows; y += 1) out += `\x1b[${y + 1};1H` + line(frame * 7 + y)
    terminal.write(out)
    return
  }
  terminal.write('\r\n' + line(frame).slice(0, columns - 1))
}

let summary: TerminalSubmittedSnapshot | undefined
let sink = 0
const observer = new FrameObserver({
  columns,
  rows,
  retainDisplayedText: true,
  needsFrameRows: () => observers,
  [observeDisplayedFrame]: (snapshot: DisplayedTextFrame) => {
    const nativeFrame = snapshot.nativeFrame
    summary = submittedFrame(summary, {
      nativeRevision: 0,
      snapshotVersion: 0,
      layout: 1,
      grid: { columns, rows } as never,
      font: {} as never,
      padding: {} as never,
      theme: {} as never,
      selection: undefined,
      scrollbar: {} as never,
      snapshot,
      previousTextRows: nativeFrame
        ? () =>
            (snapshot.previousTextRows ?? nativeFrame.readPreviousTextRows()).map((row) =>
              Object.freeze({ y: row.y, text: row.text }),
            )
        : undefined,
    })
    // Accessibility refreshes at most every 100 ms: one summary read per six 60 Hz frames.
    if (process.env.ACCESSIBILITY === 'on' && frameIndex % 6 === 0)
      sink += summary.rowPatches.length + summary.rows.length
    if (!observers) return
    sink += summary.rowPatches.length + summary.rows.length
    for (const row of snapshot.rows) sink += row.text.length
  },
} as never)

const allRows = Array.from({ length: rows }, (_, y) => y)
const timings = { write: 0, update: 0, capture: 0, ack: 0, notify: 0 }
const now = () => performance.now()
let frameIndex = 0
for (let frame = 0; frame < frames; frame += 1) {
  frameIndex = frame
  let start = now()
  advance(frame)
  timings.write += now() - start
  start = now()
  state.update()
  const cursor = state.readCursor()
  timings.update += now() - start
  start = now()
  const prepared = observer.capture(state, cursor, undefined, allRows)
  timings.capture += now() - start
  start = now()
  state.acknowledge()
  prepared.accept()
  timings.ack += now() - start
  start = now()
  prepared.notify()
  timings.notify += now() - start
}
const perFrame = Object.fromEntries(
  Object.entries(timings).map(([key, value]) => [key, Number((value / frames).toFixed(4))]),
)
const memory = runtime.exports.memory.buffer.byteLength
console.log(
  JSON.stringify({
    workload,
    observers,
    columns,
    rows,
    frames,
    perFrameMs: perFrame,
    rowsExtractedPerFrame: Object.fromEntries(
      Object.entries(extracted).map(([key, value]) => [key, value / frames]),
    ),
    wasmBytes: memory,
    sink,
  }),
)
state.dispose()
runtime.dispose()

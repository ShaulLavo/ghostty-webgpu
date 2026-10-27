// X7 attribution probe: isolated per-operation costs at one geometry on the real wasm.
import { GhosttyRuntime } from '../../src/core/runtime.js'
import { retainDisplayedFrame } from '../../src/render/shared/displayed-frame.js'

const columns = 200
const rows = 50
const runtime = await GhosttyRuntime.create()
const terminal = runtime.createTerminal({
  columns,
  rows,
  scrollback: 2000,
} as never)
const state = runtime.createRenderState(terminal)
const unicode = process.env.UNICODE === '1'
function line(seed: number): string {
  const base = unicode ? 'αβγ 界 é ' : 'alpha beta gamma '
  let text = ''
  while (text.length < columns - 20) text += base + seed + ' '
  return text
}
const reps = 400
function time(label: string, prepare: (i: number) => void, run: () => unknown): void {
  let total = 0
  for (let i = 0; i < reps; i += 1) {
    prepare(i)
    const start = performance.now()
    run()
    total += performance.now() - start
  }
  console.log(label.padEnd(44), (total / reps).toFixed(4), 'ms')
}
function dense(i: number): void {
  let out = ''
  for (let y = 0; y < rows; y += 1) out += `\x1b[${y + 1};1H\x1b[2K` + line(i * 7 + y)
  terminal.write(out)
  state.update()
}
const all = new Set(Array.from({ length: rows }, (_, y) => y))
time('live readTextRows (all rows)', dense, () => state.readTextRows())
time('live readTextRows (rows option, 50)', dense, () => state.readTextRows({ rows: all }))
time('live readTextRows (1 row)', dense, () => state.readTextRows({ rows: new Set([3]) }))
time('live readRows packed (all rows)', dense, () => state.readRows({ packed: true }))
let frame: ReturnType<(typeof state)[typeof retainDisplayedFrame]> | undefined
time('native capture, all rows dirty', dense, () => {
  frame = state[retainDisplayedFrame]({ full: frame === undefined })
  frame.accept()
  state.acknowledge()
})
time(
  'native capture, nothing dirty',
  () => {},
  () => {
    frame = state[retainDisplayedFrame]()
    frame.accept()
  },
)
time(
  'native readTextRows (all rows, fresh frame)',
  (i) => {
    dense(i)
    frame = state[retainDisplayedFrame]()
    frame.accept()
    state.acknowledge()
  },
  () => frame!.readTextRows(),
)
time(
  'native readPreviousTextRows (fresh frame)',
  (i) => {
    dense(i)
    frame = state[retainDisplayedFrame]()
    frame.accept()
    state.acknowledge()
  },
  () => frame!.readPreviousTextRows(),
)
state.dispose()
runtime.dispose()

import { retainDisplayedFrame } from '../../render/displayed-frame.js'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { CallbackBridge } from '../bridge.js'
import { GhosttyResult } from '../abi.js'
import { GhosttyRuntime } from '../runtime.js'

let runtime: GhosttyRuntime | undefined
let probe: CallbackBridge | undefined
let original: CallbackBridge | undefined
let rawReads = 0
let failRawAt = 0

afterEach(() => {
  if (runtime && original) Reflect.set(runtime, 'bridge', original)
  probe?.dispose()
  runtime?.dispose()
  runtime = undefined
  probe = undefined
  original = undefined
  failRawAt = 0
})

async function measuredState() {
  runtime = await GhosttyRuntime.create()
  original = runtime.bridge
  probe = new CallbackBridge(
    {
      ...runtime.exports,
      ghostty_render_state_row_get: (...args) => {
        // CELLS_RAW is bridge-only; the public row binding reads cells through its iterator.
        if (args[1] === 5) {
          rawReads += 1
          if (rawReads === failRawAt) return GhosttyResult.InvalidValue
        }
        return runtime!.exports.ghostty_render_state_row_get(...args)
      },
    },
    runtime.layouts,
  )
  const module = await WebAssembly.compile(
    await readFile(new URL('../../../bridge.wasm', import.meta.url)),
  )
  const instance = await WebAssembly.instantiate(module, probe.imports)
  probe.install(instance.exports as Parameters<CallbackBridge['install']>[0])
  Reflect.set(runtime, 'bridge', probe)
  const terminal = runtime.createTerminal({ columns: 16, rows: 4 })
  const state = runtime.createRenderState(terminal)
  const capture = (full = false) => {
    rawReads = 0
    const frame = state[retainDisplayedFrame]({ full })
    const reads = rawReads
    const expected = state.readRows().map(({ dirty: _dirty, ...row }) => row)
    expect(frame.readRows().map(({ dirty: _dirty, ...row }) => row)).toEqual(expected)
    state.acknowledge()
    frame.accept()
    return { frame, reads }
  }
  return { terminal, state, capture }
}

describe('incremental retained native rows', () => {
  it('captures only logical dirty rows across all three slots and cursor-only frames', async () => {
    const { terminal, state, capture } = await measuredState()
    terminal.write('first\r\n界 é 🧑‍💻\r\nthird\r\nfourth')
    state.update()
    expect(capture().reads).toBe(4)
    for (let index = 0; index < 6; index += 1) {
      terminal.write(`\x1b[1;1Hedit ${index}`)
      state.update()
      // Moving the cursor also dirties its previous native row.
      expect(capture().reads).toBe(index === 0 ? 2 : 1)
    }
    terminal.write('\x1b[2;1H')
    state.update()
    expect(capture().reads).toBe(2)
    state.update()
    expect(capture().reads).toBe(0)
  })

  it('captures concealed logical edits even when displayed glyphs are unchanged', async () => {
    const { terminal, state, capture } = await measuredState()
    terminal.write('\x1b[8mhidden one')
    state.update()
    capture()
    terminal.write('\rhidden two')
    state.update()
    const result = capture()
    expect(result.reads).toBe(1)
    expect(result.frame.readTextRows()[0]?.text).toContain('hidden two')
  })

  it('captures the full layout after an explicit invalidation, resize and alternate screen', async () => {
    const { terminal, state, capture } = await measuredState()
    terminal.write('primary')
    state.update()
    capture()
    expect(capture(true).reads).toBe(4)
    terminal.resize({ columns: 20, rows: 5 })
    state.update()
    expect(capture().reads).toBe(5)
    terminal.write('\x1b[?1049h alternate')
    state.update()
    expect(capture().reads).toBe(5)
    terminal.write('\x1b[?1049l')
    state.update()
    expect(capture().reads).toBe(5)
  })

  it('keeps revisions distinct when a layout returns to an earlier grid', async () => {
    const { terminal, state, capture } = await measuredState()
    terminal.write('first\r\nold 界 é 🧑‍💻')
    state.update()
    capture()
    terminal.resize({ columns: 20, rows: 5 })
    state.update()
    capture()
    terminal.resize({ columns: 16, rows: 4 })
    terminal.write('\x1b[2J\x1b[Hnew')
    state.update()
    capture()
    terminal.write('\rnext')
    state.update()
    expect(capture().frame.readTextRows()[1]?.text.trim()).toBe('')
  })

  it('keeps accepted slots after a partial capture failure and repairs the spare on recovery', async () => {
    const { terminal, state, capture } = await measuredState()
    terminal.write('first\r\n界 é 🧑‍💻\r\nthird\r\nfourth')
    state.update()
    capture()
    terminal.write('\x1b[1;1Hnext')
    state.update()
    capture()
    terminal.write('\x1b[1;1Hlast')
    state.update()
    const accepted = capture().frame
    const rows = JSON.stringify(accepted.readRows())
    const previous = JSON.stringify(accepted.readPreviousTextRows())
    terminal.write('\x1b[1;1Hpending\x1b[2;1Hnew 界 é 🧑‍💻')
    state.update()
    failRawAt = 2
    expect(() => capture()).toThrow('retain_frame failed')
    failRawAt = 0
    expect(JSON.stringify(accepted.readRows())).toBe(rows)
    expect(JSON.stringify(accepted.readPreviousTextRows())).toBe(previous)
    const recovered = capture().frame
    expect(recovered.readTextRows()[0]?.text).toContain('pending')
    expect(recovered.readTextRows()[1]?.text).toContain('new 界 é 🧑‍💻')
  })

  it('preserves row ownership through scrolling and partial scroll regions', async () => {
    const { terminal, state, capture } = await measuredState()
    terminal.write('row one\r\n界 é 🧑‍💻\r\nrow three\r\nrow four')
    state.update()
    const held = capture().frame.readTextRows()
    const bytes = JSON.stringify(held)
    terminal.write('\r\nrow five')
    state.update()
    capture()
    terminal.write('\x1b[2;3r\x1b[3;1H\nregion tail')
    state.update()
    capture()
    expect(JSON.stringify(held)).toBe(bytes)
  })
})

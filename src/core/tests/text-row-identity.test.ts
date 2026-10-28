import { afterEach, expect, it, vi } from 'vitest'
import { GhosttyRuntime } from '../runtime.js'
import { retainDisplayedFrame } from '../../render/shared/displayed-frame.js'

let runtime: GhosttyRuntime | undefined

afterEach(() => {
  vi.restoreAllMocks()
  runtime?.dispose()
})

it('extracts only the new rows after an observed N-row scroll', async () => {
  runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 24, rows: 8 })
  const state = runtime.createRenderState(terminal)
  const publish = () => {
    state.update()
    const frame = state[retainDisplayedFrame]()
    const expected = state.readTextRows()
    expect(frame.readTextRows()).toEqual(expected)
    state.acknowledge()
    frame.accept()
    return frame.readTextRows()
  }
  terminal.write(Array.from({ length: 8 }, (_, y) => `row ${y} 界 é`).join('\r\n'))
  publish()
  terminal.write('\r\nprime 🧑‍💻')
  publish()
  const read = runtime.bridge.readRetainedText.bind(runtime.bridge)
  let extracted = 0
  const memory = runtime.exports.memory
  vi.spyOn(runtime.bridge, 'readRetainedText').mockImplementation((...args) => {
    extracted +=
      args[3] === 0
        ? 8
        : Array.from(new Uint8Array(memory.buffer, args[3], args[4])).reduce(
            (sum, flag) => sum + Number(flag !== 0),
            0,
          )
    return read(...args)
  })
  terminal.write('\r\nnew one\r\nnew two')
  const rows = publish()
  expect(extracted).toBe(2)
  expect(rows.map((row) => row.y)).toEqual(Array.from({ length: 8 }, (_, y) => y))
  expect(rows[0]?.cells).toContain('界')
  expect(rows[0]?.cells).toContain('é')
})

it('compares same-id cells and graphemes while ignoring style changes', async () => {
  runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 24, rows: 3 })
  const state = runtime.createRenderState(terminal)
  const publish = () => {
    state.update()
    const frame = state[retainDisplayedFrame]()
    expect(frame.readTextRows()).toEqual(state.readTextRows())
    state.acknowledge()
    frame.accept()
    return frame.readTextRows()
  }
  terminal.write('first 界 é')
  const owned = publish()
  const original = JSON.stringify(owned)
  terminal.write('\x1b[2;1Hprimed')
  const baseline = publish()
  terminal.write('\x1b[H\x1b[2K\x1b[31mfirst 界 é\x1b[0m')
  const styled = publish()
  expect(styled[0]).toBe(baseline[0])
  let previous = styled
  for (const text of ['first 界 è', 'first 👩‍💻 è', 'first 界 é', 'first 界 é']) {
    terminal.write(`\x1b[H\x1b[2K${text}`)
    const rows = publish()
    expect(rows[0]).not.toBe(previous[0])
    previous = rows
  }
  runtime.dispose()
  expect(JSON.stringify(owned)).toBe(original)
})

it('keeps moved accepted rows after a populated scroll attempt is discarded', async () => {
  runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 24, rows: 4 })
  const state = runtime.createRenderState(terminal)
  const publish = () => {
    state.update()
    const frame = state[retainDisplayedFrame]()
    expect(frame.readTextRows()).toEqual(state.readTextRows())
    state.acknowledge()
    frame.accept()
    return frame
  }
  terminal.write('one 界\r\ntwo é\r\nthree 🧑‍💻\r\nfour ☕️')
  publish()
  terminal.write('\r\nprime')
  const accepted = publish().readTextRows()
  const original = JSON.stringify(accepted)
  terminal.write('\r\nabandoned 界 è')
  state.update()
  const pending = state[retainDisplayedFrame]()
  expect(pending.readTextRows()).toEqual(state.readTextRows())
  pending.discard()
  terminal.write('\r\ndifferent retry 👩‍💻')
  const retry = publish()
  expect(retry.readPreviousTextRows()).toEqual(accepted)
  expect(JSON.stringify(accepted)).toBe(original)
})

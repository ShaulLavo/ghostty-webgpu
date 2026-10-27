import { retainDisplayedFrame } from '../../render/shared/displayed-frame.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalSession } from '../../term/session.js'
import { DisplayedFrameStore } from '../displayed-frame.js'
import { GhosttyRuntime } from '../runtime.js'
import type { GhosttyRenderState } from '../render-state.js'

let runtime: GhosttyRuntime | undefined

afterEach(() => {
  runtime?.dispose()
  runtime = undefined
})

function handles(state: GhosttyRenderState) {
  const snapshot = Reflect.get(state, 'snapshotState')
  return ['state', 'iterator', 'cells'].map(
    (key) => (Reflect.get(snapshot, key) as { handle: number }).handle,
  ) as [number, number, number]
}

function serialized(value: unknown): string {
  return JSON.stringify(value)
}

describe('retained native displayed frame', () => {
  it.each([
    'ASCII text\r\nsecond row',
    '界 é 🧑‍💻 ☕️\r\n👩‍👩‍👧‍👦',
    '\u001b[1;3;4;38;2;12;34;56;48;5;26mstyle\u001b[0m plain\r\n\u001b[48;2;91;82;73m\u001b[K',
    '\u001b[8mconcealed\u001b[0m\r\n\u001b[2;5;7;9;53mflags\u001b[0m',
  ])('matches pushed text bytes and retained styled cells for %j', async (output) => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 30, rows: 4 })
    const state = runtime.createRenderState(terminal)
    terminal.write(output)
    state.update()
    const pushed = serialized(state.readTextRows())
    const styles = serialized(state.readRows().map(({ dirty: _dirty, ...row }) => row))
    const displayed = state[retainDisplayedFrame]()
    displayed.accept()
    expect(serialized(displayed.readTextRows())).toBe(pushed)
    expect(serialized(displayed.readRows().map(({ dirty: _dirty, ...row }) => row))).toBe(styles)
    expect(displayed.readTextRows({ rows: new Set([1]) })).toEqual(
      state.readTextRows({ rows: new Set([1]) }),
    )
  })

  it('shares extracted text with the next frame history and unchanged rows', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 24, rows: 4 })
    const state = runtime.createRenderState(terminal)
    terminal.write('first\r\n界 é 🧑‍💻\r\nthird')
    state.update()
    const first = state[retainDisplayedFrame]()
    first.accept()
    state.acknowledge()
    const owned = first.readTextRows()
    const read = vi.spyOn(runtime.bridge, 'readRetainedText')
    try {
      terminal.write('\x1b[1;1Hnext')
      state.update()
      const second = state[retainDisplayedFrame]()
      expect(second.readPreviousTextRows()).toEqual(owned)
      expect(read).not.toHaveBeenCalled()
      const rows = second.readTextRows()
      expect(rows).toEqual(state.readTextRows())
      expect(rows[3]).toBe(owned[3])
      read.mockClear()
      expect(second.readTextRows()).toBe(rows)
      expect(read).not.toHaveBeenCalled()
      second.accept()
      state.acknowledge()
      state.update()
      const third = state[retainDisplayedFrame]()
      expect(third.readTextRows()).toEqual(rows)
      expect(third.readPreviousTextRows()).toEqual(rows)
      expect(read).not.toHaveBeenCalled()
      third.discard()
      expect(owned[0]?.text).toContain('first')
    } finally {
      read.mockRestore()
    }
  })

  it('matches dense, scrolling, styled and Unicode text through resize and lazy history', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 24, rows: 5 })
    const state = runtime.createRenderState(terminal)
    let previous = '[]'
    for (let index = 0; index < 40; index += 1) {
      const outputs = [
        `\x1b[H\x1b[2Jdense ${index}\r\n` + `row ${index} `.repeat(6),
        `\r\nscroll ${index} 界 é 🧑‍💻 ☕️`,
        `\x1b[3;1H\x1b[2K\x1b[1;38;2;1;2;3mstyled ${index}\x1b[0m`,
        '',
        `\x1b[${(index % 4) + 1};5H${index % 3 === 0 ? ' ' : 'x'}`,
      ]
      terminal.write(outputs[index % outputs.length]!)
      if (index === 23) terminal.resize({ columns: 30, rows: 6 })
      state.update()
      const live = serialized(state.readTextRows())
      const frame = state[retainDisplayedFrame]()
      state.acknowledge()
      frame.accept()
      expect(serialized(frame.readTextRows())).toBe(live)
      expect(serialized(frame.readPreviousTextRows())).toBe(previous)
      previous = live
    }
  })

  it('retires cached rows with their native slots without native reads during acceptance', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 24, rows: 4 })
    const state = runtime.createRenderState(terminal)
    const store = new DisplayedFrameStore(runtime)
    const cache = Reflect.get(Reflect.get(store, 'frames'), 'textCache')
    const retained: unknown = Reflect.get(cache, 'rows')
    if (!(retained instanceof Map)) throw new Error('Expected revision cache')
    const revisions = vi.spyOn(runtime.bridge, 'readRetainedRevisions')
    let held = ''
    let owned: ReturnType<ReturnType<typeof store.capture>['readTextRows']> = []
    try {
      for (let index = 0; index < 4; index += 1) {
        terminal.write(`\x1b[H\x1b[2Jframe ${index} 界 é`)
        state.update()
        const frame = store.capture(...handles(state), { columns: 24, rows: 4 }, true)
        const rows = frame.readTextRows()
        owned = index === 0 ? rows : owned
        held = index === 0 ? serialized(owned) : held
        const reads = revisions.mock.calls.length
        frame.accept()
        expect(revisions.mock.calls.length).toBe(reads)
        expect(retained.size).toBe(Math.min(index + 1, 2) * 4)
        state.acknowledge()
      }
      expect(serialized(owned)).toBe(held)
    } finally {
      revisions.mockRestore()
      store.dispose()
    }
    expect(serialized(owned)).toBe(held)
  })

  it('retains selected cells after native selection is cleared', async () => {
    runtime = await GhosttyRuntime.create()
    const session = await TerminalSession.create<Event>({
      runtime: { kind: 'borrowed', runtime },
      appearance: { grid: { columns: 16, rows: 3 } },
    })
    try {
      session.write('selected text')
      session.selectRange({ x: 1, y: 0 }, { x: 7, y: 0 })
      session.renderState.update()
      const rows = session.renderState.readRows()
      expect(rows[0]?.cells.some((cell) => cell.selected)).toBe(true)
      const expected = serialized(rows.map(({ dirty: _dirty, ...row }) => row))
      const displayed = (session.renderState as GhosttyRenderState)[retainDisplayedFrame]!()
      displayed.accept()
      session.clearSelection()
      session.renderState.update()
      expect(serialized(displayed.readRows().map(({ dirty: _dirty, ...row }) => row))).toBe(
        expected,
      )
    } finally {
      session.dispose()
    }
  })

  it('keeps displayed bytes through newer native updates, resize, and WASM memory growth', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 16, rows: 3 })
    const state = runtime.createRenderState(terminal)
    terminal.write('displayed 界')
    state.update()
    const pushed = serialized(state.readTextRows())
    const displayed = state[retainDisplayedFrame]()
    displayed.accept()
    terminal.write('\rnew native state')
    state.update()
    expect(serialized(state.readTextRows())).not.toBe(pushed)
    runtime.exports.memory.grow(1)
    expect(serialized(displayed.readTextRows())).toBe(pushed)
    terminal.resize({ columns: 20, rows: 4 })
    state.update()
    expect(serialized(displayed.readTextRows())).toBe(pushed)
    const owned = displayed.readTextRows()
    const resized = state[retainDisplayedFrame]()
    resized.accept()
    expect(resized.readTextRows()).toHaveLength(4)
    expect(resized.readTextRows()[0]?.cells).toHaveLength(20)
    expect(serialized(resized.readPreviousTextRows())).toBe(pushed)
    expect(() => displayed.readTextRows()).toThrow('token has retired')
    state.dispose()
    expect(serialized(owned)).toBe(pushed)
    expect(() => resized.readTextRows()).toThrow('token has retired')
  })

  it('preserves accepted readers through pending replacement, discard and spare reuse', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 12, rows: 2 })
    const state = runtime.createRenderState(terminal)
    const store = new DisplayedFrameStore(runtime)
    try {
      terminal.write('first')
      state.update()
      store.capture(...handles(state), { columns: 12, rows: 2 }).accept()
      terminal.write('\rsecond')
      state.update()
      const previous = serialized(state.readTextRows())
      store.capture(...handles(state), { columns: 12, rows: 2 }).accept()
      terminal.write('\rthird 界')
      state.update()
      const expected = serialized(state.readTextRows())
      const accepted = store.capture(...handles(state), { columns: 12, rows: 2 })
      accepted.accept()
      terminal.resize({ columns: 16, rows: 3 })
      terminal.write('\rpending')
      state.update()
      const pending = store.capture(...handles(state), { columns: 16, rows: 3 })
      expect(() => store.capture(...handles(state), { columns: 16, rows: 3 })).toThrow(
        'awaiting acceptance',
      )
      expect(serialized(accepted.readTextRows())).toBe(expected)
      expect(serialized(accepted.readPreviousTextRows())).toBe(previous)
      expect(accepted.readRows()).toHaveLength(2)
      pending.discard()
      pending.discard()
      const recovered = store.capture(...handles(state), { columns: 16, rows: 3 })
      expect(() => pending.readTextRows()).toThrow('token has retired')
      expect(serialized(accepted.readTextRows())).toBe(expected)
      expect(recovered.readTextRows()[0]?.text).toContain('pending')
      recovered.accept()
      recovered.discard()
      expect(() => accepted.readTextRows()).toThrow('token has retired')
      expect(serialized(recovered.readPreviousTextRows())).toBe(expected)
      terminal.write('\rdispose pending')
      state.update()
      const disposed = store.capture(...handles(state), { columns: 16, rows: 3 })
      store.dispose()
      expect(() => disposed.readTextRows()).toThrow('token has retired')
    } finally {
      store.dispose()
    }
  })

  it('shares prototype readers between captures while keeping immutable generation identities', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 12, rows: 2 })
    const state = runtime.createRenderState(terminal)
    terminal.write('first')
    state.update()
    const first = state[retainDisplayedFrame]()
    first.accept()
    terminal.write('second')
    state.update()
    const second = state[retainDisplayedFrame]()
    for (const method of [
      'accept',
      'discard',
      'readRows',
      'readTextRows',
      'readPreviousTextRows',
    ] as const) {
      expect(second[method]).toBe(first[method])
      expect(Object.hasOwn(second, method)).toBe(false)
    }
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(second)).toBe(true)
    expect(second.token).toBeGreaterThan(first.token)
    const owned = first.readTextRows()
    second.accept()
    expect(() => first.readTextRows()).toThrow('token has retired')
    expect(owned[0]?.text).not.toContain('second')
    expect(second.readTextRows()[0]?.text).toContain('second')
    expect(second.readTextRows()).toBe(second.readTextRows())
  })

  it('preserves both displayed generations when a native retention capture fails and disposes twice', async () => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 12, rows: 2 })
    const state = runtime.createRenderState(terminal)
    const store = new DisplayedFrameStore(runtime)
    try {
      terminal.write('first')
      state.update()
      const first = store.capture(...handles(state), { columns: 12, rows: 2 })
      first.accept()
      const firstBytes = serialized(first.readTextRows())
      terminal.write('\rsecond')
      state.update()
      const second = store.capture(...handles(state), { columns: 12, rows: 2 })
      second.accept()
      const secondBytes = serialized(second.readTextRows())
      terminal.write('\rfailed third')
      state.update()
      expect(() => store.capture(...handles(state), { columns: 11, rows: 2 })).toThrow()
      expect(serialized(second.readTextRows())).toBe(secondBytes)
      expect(serialized(second.readPreviousTextRows())).toBe(firstBytes)
      store.dispose()
      store.dispose()
      expect(() => store.capture(...handles(state), { columns: 12, rows: 2 })).toThrow('disposed')
    } finally {
      store.dispose()
    }
  })
})

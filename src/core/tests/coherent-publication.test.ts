import { afterEach, expect, it, vi } from 'vitest'
import { GhosttyRuntime } from '../runtime.js'
import { FrameObserver } from '../../render/shared/frame-observer.js'
import {
  observeDisplayedFrame,
  type DisplayedFrameOptions,
  type DisplayedTextFrame,
} from '../../render/shared/displayed-frame.js'

let runtime: GhosttyRuntime | undefined

afterEach(() => {
  vi.restoreAllMocks()
  runtime?.dispose()
  runtime = undefined
})

const outputs: readonly ((frame: number) => string)[] = [
  (frame) => `\x1b[H\x1b[2Jdense ${frame}\r\n` + `row ${frame} `.repeat(6),
  (frame) => `\r\nscroll ${frame} 界 é 🧑‍💻 ☕️`,
  (frame) => `\x1b[3;1H\x1b[2K\x1b[1;38;2;1;2;3mstyled ${frame}\x1b[0m`,
  () => '',
]

it.each([false, true])(
  'derives displayed text without live extraction, text listener=%s',
  async (textListener) => {
    runtime = await GhosttyRuntime.create()
    const terminal = runtime.createTerminal({ columns: 24, rows: 5 })
    const state = runtime.createRenderState(terminal)
    let observed: DisplayedTextFrame | undefined
    let notified = ''
    const options: ConstructorParameters<typeof FrameObserver>[0] & DisplayedFrameOptions = {
      rows: 5,
      retainDisplayedText: true,
      needsFrameRows: () => textListener,
      onTextFrame: textListener
        ? (frame) => {
            notified = JSON.stringify(frame.rows)
          }
        : undefined,
      [observeDisplayedFrame]: (frame) => {
        observed = frame
      },
    }
    const observer = new FrameObserver(options)
    let previous = '[]'
    for (let index = 0; index < 40; index += 1) {
      terminal.write(outputs[index % outputs.length]!(index))
      if (index === 23) {
        terminal.resize({ columns: 30, rows: 6 })
        observer.resize(6)
      }
      state.update()
      const expected = JSON.stringify(state.readTextRows())
      const live = vi.spyOn(state, 'readTextRows')
      const prepared = observer.capture(state, state.readCursor(), undefined, [])
      try {
        expect(live).not.toHaveBeenCalled()
        state.acknowledge()
        prepared.accept()
        prepared.notify()
        expect(JSON.stringify(observed?.rows)).toBe(expected)
        expect(JSON.stringify(observed?.nativeFrame?.readPreviousTextRows())).toBe(previous)
        if (textListener) expect(notified).toBe(expected)
        previous = expected
      } finally {
        live.mockRestore()
        prepared.discard()
      }
    }
  },
)

it('discards a capture when retained extraction fails and retries different output', async () => {
  runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 24, rows: 4 })
  const state = runtime.createRenderState(terminal)
  let observed: DisplayedTextFrame | undefined
  let notified = ''
  const options: ConstructorParameters<typeof FrameObserver>[0] & DisplayedFrameOptions = {
    rows: 4,
    retainDisplayedText: true,
    onTextFrame: (frame) => {
      notified = JSON.stringify(frame.rows)
    },
    [observeDisplayedFrame]: (frame) => {
      observed = frame
    },
  }
  const observer = new FrameObserver(options)
  const publish = () => {
    const prepared = observer.capture(state, state.readCursor(), undefined, [])
    state.acknowledge()
    prepared.accept()
    prepared.notify()
  }
  terminal.write('accepted 界 é')
  state.update()
  publish()
  const accepted = observed
  const before = notified
  terminal.write('\r\x1b[2Kabandoned 🧑‍💻')
  state.update()
  const fail = vi.spyOn(runtime.bridge, 'readRetainedText').mockReturnValue(-1)
  try {
    expect(publish).toThrow()
    expect(observed).toBe(accepted)
    expect(notified).toBe(before)
  } finally {
    fail.mockRestore()
  }
  terminal.write('\r\x1b[2Kretry ☕️')
  state.update()
  const expected = JSON.stringify(state.readTextRows())
  publish()
  expect(JSON.stringify(observed?.rows)).toBe(expected)
  expect(notified).toBe(expected)
  expect(JSON.stringify(observed?.nativeFrame?.readPreviousTextRows())).toBe(before)
})

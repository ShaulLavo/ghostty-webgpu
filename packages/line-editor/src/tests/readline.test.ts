import type {
  TerminalGeometry,
  TerminalMutationResult,
  TerminalTextMeasurement,
} from 'ghostty-webgpu'
import { expect, test, vi } from 'vitest'
import { ReadSession } from '../session.js'
import { ReadlineRenderer, type ReadlineTerminal } from '../readline.js'

const geometry: TerminalGeometry = {
  revision: 1,
  columns: 80,
  rows: 24,
  cellWidth: 8,
  cellHeight: 16,
  cursor: { pendingWrap: false, visible: true, x: 0, y: 0 },
  scrollbar: { length: 24, offset: 0, total: 24 },
  graphemeClustering: true,
  autowrap: true,
}

function measureTexts(texts: readonly string[]): TerminalTextMeasurement {
  return {
    geometry,
    texts: texts.map((text) => ({
      cells: text.length,
      units: Array.from(text, (_, index) => ({ start: index, end: index + 1, cells: 1 })),
    })),
  }
}

function fakeTerminal(writes: string[]): ReadlineTerminal {
  const write = (data: string | Uint8Array): TerminalMutationResult => {
    writes.push(typeof data === 'string' ? data : new TextDecoder().decode(data))
    return { revision: writes.length }
  }
  return { geometry: () => geometry, measureTexts, write } satisfies ReadlineTerminal
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function fixture() {
  const writes: string[] = []
  const terminal = fakeTerminal(writes)
  const write = vi.spyOn(terminal, 'write')
  const measure = vi.spyOn(terminal, 'measureTexts')
  const onError = vi.fn()
  let renderer: ReadlineRenderer
  const session = new ReadSession({}, (event) => renderer.handle(event))
  renderer = new ReadlineRenderer(terminal, session, onError)
  const dispose = () => {
    renderer.dispose()
    session.dispose()
  }
  return { writes, write, measure, onError, session, renderer, dispose }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

test('renders a read and leaves the submitted line above the next cursor', async () => {
  const { writes, session, renderer, dispose } = fixture()
  try {
    const pending = session.read({ prompt: '$ ' })
    void pending.catch(() => {})
    await settle()
    await session.dispatch({ kind: 'insert', text: 'echo hi' })
    await settle()
    await session.dispatch({ kind: 'submit' })
    const result = await pending
    renderer.finish(result)
    expect(result).toEqual({ kind: 'submit', text: 'echo hi' })
    await settle()

    expect(writes.join('')).toContain('$ echo hi\r\n')
  } finally {
    dispose()
  }
})

test('prints output above an active prompt and restores the edit line', async () => {
  const { writes, session, renderer, dispose } = fixture()
  try {
    void session.read({ prompt: '$ ' }).catch(() => {})
    await settle()
    await session.dispatch({ kind: 'insert', text: 'typed' })
    await settle()
    renderer.print('output\r\n')
    await settle()

    expect(writes.join('')).toContain('output\r\n')
    expect(writes.at(-1)).toContain('$ typed')
  } finally {
    dispose()
  }
})

test('normalizes printed line endings without disturbing a rejected second read', async () => {
  const { writes, session, renderer, dispose } = fixture()
  try {
    void session.read({ prompt: '$ ' }).catch(() => {})
    await settle()
    await expect(session.read({ prompt: '> ' })).rejects.toMatchObject({
      code: 'line-editor.READ_PENDING',
    })
    renderer.print('one\ntwo')
    await settle()

    expect(writes.join('')).toContain('one\r\ntwo\r\n')
    expect(session.active).toBe(true)
  } finally {
    dispose()
  }
})

test('drops queued prints and finishes when disposed before execution', async () => {
  const { write, renderer, dispose } = fixture()
  try {
    renderer.print('abandoned queued output')
    renderer.finish({ kind: 'end' })
    dispose()
    await settle()

    expect(write).not.toHaveBeenCalled()
  } finally {
    dispose()
  }
})

test('does not write a captured prompt after its suspended measurement resolves on disposal', async () => {
  const { write, measure, session, renderer, dispose } = fixture()
  const entered = deferred<void>()
  const measurement = deferred<TerminalTextMeasurement>()
  measure.mockImplementationOnce(() => {
    entered.resolve()
    return measurement.promise
  })
  try {
    void session.read({ prompt: 'abandoned measured prompt> ' }).catch(() => {})
    await entered.promise
    dispose()
    measurement.resolve(measureTexts(['abandoned measured prompt> ']))
    await settle()

    expect(measure).toHaveBeenCalledOnce()
    expect(write).not.toHaveBeenCalled()
    renderer.print('also abandoned')
    await settle()
    expect(write).not.toHaveBeenCalled()
  } finally {
    measurement.resolve(measureTexts([]))
    dispose()
  }
})

test('consumes a rejected measurement only after its render is abandoned', async () => {
  const { write, measure, onError, session, dispose } = fixture()
  const entered = deferred<void>()
  const measurement = deferred<TerminalTextMeasurement>()
  measure.mockImplementationOnce(() => {
    entered.resolve()
    return measurement.promise
  })
  try {
    void session.read({ prompt: 'abandoned rejection> ' }).catch(() => {})
    await entered.promise
    dispose()
    measurement.reject(new Error('abandoned measurement'))
    await settle()

    expect(measure).toHaveBeenCalledOnce()
    expect(write).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  } finally {
    measurement.resolve(measureTexts([]))
    dispose()
  }
})

test('reports a live measurement rejection once and continues queued output', async () => {
  const { writes, measure, onError, session, renderer, dispose } = fixture()
  const entered = deferred<void>()
  const measurement = deferred<TerminalTextMeasurement>()
  const cause = new Error('live measurement failure')
  measure.mockImplementationOnce(() => {
    entered.resolve()
    return measurement.promise
  })
  try {
    void session.read({ prompt: 'live> ' }).catch(() => {})
    await entered.promise
    measurement.reject(cause)
    await settle()

    expect(onError).toHaveBeenCalledExactlyOnceWith(cause, 'readline.render')
    expect(writes).toEqual([])
    renderer.print('still live')
    await settle()
    expect(writes).toEqual(['still live\r\n', 'live> \u001b[7G'])
  } finally {
    measurement.resolve(measureTexts([]))
    dispose()
  }
})

test.each(['resolve', 'reject'])(
  'preserves an issued write on %s without later prints, finishes or measurements',
  async (outcome) => {
    const { write, measure, onError, session, renderer, dispose } = fixture()
    const entered = deferred<void>()
    const mutation = deferred<TerminalMutationResult>()
    const cause = new Error('issued write failure')
    try {
      void session.read({ prompt: 'live during write> ' }).catch(() => {})
      await settle()
      write.mockClear()
      measure.mockClear()
      write.mockImplementationOnce(() => {
        entered.resolve()
        return mutation.promise
      })
      renderer.print('issued output')
      await entered.promise
      renderer.print('abandoned later output')
      renderer.finish({ kind: 'end' })
      renderer.dispose()
      if (outcome === 'resolve') mutation.resolve({ revision: 2 })
      if (outcome === 'reject') mutation.reject(cause)
      await settle()

      expect(write).toHaveBeenCalledExactlyOnceWith('\r\u001b[Jissued output\r\n')
      expect(measure).not.toHaveBeenCalled()
      if (outcome === 'reject') {
        expect(onError).toHaveBeenCalledExactlyOnceWith(cause, 'readline.render')
      }
      if (outcome === 'resolve') expect(onError).not.toHaveBeenCalled()
    } finally {
      mutation.resolve({ revision: 2 })
      dispose()
    }
  },
)

test('keeps queued prints and finish in FIFO order while the renderer is active', async () => {
  const { write, onError, renderer, dispose } = fixture()
  const entered = deferred<void>()
  const mutation = deferred<TerminalMutationResult>()
  write.mockImplementationOnce(() => {
    entered.resolve()
    return mutation.promise
  })
  try {
    renderer.print('first')
    renderer.print('second')
    renderer.finish({ kind: 'end' })
    await entered.promise
    expect(write.mock.calls).toEqual([['first\r\n']])
    mutation.resolve({ revision: 1 })
    await settle()

    expect(write.mock.calls).toEqual([['first\r\n'], ['second\r\n'], ['\r\n']])
    expect(onError).not.toHaveBeenCalled()
  } finally {
    mutation.resolve({ revision: 1 })
    dispose()
  }
})

test('emits CRLF for model newlines in live and submitted content', async () => {
  const { writes, session, renderer, dispose } = fixture()
  try {
    const pending = session.read({ prompt: '$ ', secondaryPrompt: '> ' })
    void pending.catch(() => {})
    await settle()
    await session.dispatch({ kind: 'insert', text: 'ab\ncd' })
    await settle()
    expect(writes.at(-1)).toContain('$ ab\r\n> cd')
    expect(session.model.snapshot.text).toBe('ab\ncd')
    await session.dispatch({ kind: 'submit' })
    const result = await pending
    renderer.finish(result)
    await settle()
    expect(result).toEqual({ kind: 'submit', text: 'ab\ncd' })
    expect(writes.at(-1)).toContain('$ ab\r\n> cd\r\n')
  } finally {
    dispose()
  }
})

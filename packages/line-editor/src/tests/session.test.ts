import { expect, test } from 'vitest'
import { ReadSession } from '../session.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('one active read submits a typed result and records bounded history', async () => {
  const session = new ReadSession()
  const pending = session.read({ prompt: '$ ' })
  await expect(session.read({ prompt: '$ ' })).rejects.toMatchObject({
    code: 'line-editor.READ_PENDING',
  })
  await session.dispatch({ kind: 'insert', text: 'echo hi' })
  await session.dispatch({ kind: 'submit' })
  expect(await pending).toEqual({ kind: 'submit', text: 'echo hi' })
  expect(session.model.history.entries).toEqual(['echo hi'])
})

test('abort and disposal cancel pending work and detach signal listeners', async () => {
  const signal = new AbortController()
  const session = new ReadSession()
  const pending = session.read({ prompt: '$ ', signal: signal.signal })
  const aborted = expect(pending).rejects.toMatchObject({ code: 'line-editor.READ_ABORTED' })
  signal.abort()
  await aborted
  const next = session.read({ prompt: '$ ' })
  const disposed = expect(next).rejects.toMatchObject({ code: 'line-editor.DISPOSED' })
  session.dispose()
  session.dispose()
  await disposed
  await expect(session.read({ prompt: '$ ' })).rejects.toMatchObject({
    code: 'line-editor.DISPOSED',
  })
})

test('CtrlC clears and prints ^C, CtrlD ends empty input and deletes a nonempty character', async () => {
  const output: string[] = []
  const session = new ReadSession({}, (event) => {
    if (event.kind === 'output') output.push(event.text)
  })
  const first = session.read({ prompt: '$ ' })
  await session.dispatch({ kind: 'insert', text: 'unfinished' })
  await session.dispatch({ kind: 'interrupt' })
  expect(await first).toEqual({ kind: 'interrupt' })
  expect(session.model.snapshot.text).toBe('')
  expect(output).toEqual(['^C\r\n'])
  const second = session.read({ prompt: '$ ' })
  await session.dispatch({ kind: 'insert', text: 'abc' })
  await session.dispatch({ kind: 'start' })
  await session.dispatch({ kind: 'eof' })
  expect(session.model.snapshot.text).toBe('bc')
  await session.dispatch({ kind: 'kill-end' })
  await session.dispatch({ kind: 'eof' })
  expect(await second).toEqual({ kind: 'end' })
})

test('completion inserts a candidate at cursor and preserves the suffix', async () => {
  const session = new ReadSession({ complete: async () => ['hello'] })
  const read = session.read({ prompt: '$ ' })
  await session.dispatch({ kind: 'insert', text: 'echo he tail' })
  for (let index = 0; index < 5; index++) await session.dispatch({ kind: 'left' })
  await session.dispatch({ kind: 'complete' })
  expect(session.model.snapshot).toMatchObject({ text: 'echo hello tail', cursor: 10 })
  await session.dispatch({ kind: 'submit' })
  await read
})

test('common prefix inserts once and the second Tab lists candidates', async () => {
  const events: (readonly string[])[] = []
  let calls = 0
  const session = new ReadSession(
    {
      complete: () => {
        calls++
        return ['hello', 'help']
      },
    },
    (event) => {
      if (event.kind === 'candidates') events.push(event.values)
    },
  )
  const read = session.read({ prompt: '$ ' })
  await session.dispatch({ kind: 'insert', text: 'he' })
  await session.dispatch({ kind: 'complete' })
  expect(session.model.snapshot.text).toBe('hel')
  await session.dispatch({ kind: 'complete' })
  expect(events).toEqual([['hello', 'help']])
  expect(calls).toBe(1)
  await session.dispatch({ kind: 'submit' })
  await read
})

test('editing invalidates completion and an abort-aware callback gets cancellation', async () => {
  const pending = deferred<readonly string[]>()
  let completionSignal: AbortSignal | undefined
  const session = new ReadSession({
    complete: (_line, _cursor, signal) => {
      completionSignal = signal
      return pending.promise
    },
  })
  const read = session.read({ prompt: '$ ' })
  await session.dispatch({ kind: 'insert', text: 'a' })
  const complete = session.dispatch({ kind: 'complete' })
  await session.dispatch({ kind: 'insert', text: 'b' })
  expect(completionSignal?.aborted).toBe(true)
  pending.resolve(['apple'])
  await complete
  expect(session.model.snapshot.text).toBe('ab')
  await session.dispatch({ kind: 'submit' })
  await read
})

test('an earlier completion cannot replace a later request or a later read', async () => {
  const first = deferred<readonly string[]>()
  const second = deferred<readonly string[]>()
  let calls = 0
  const session = new ReadSession({
    complete: () => (++calls === 1 ? first.promise : second.promise),
  })
  const read = session.read({ prompt: '$ ' })
  await session.dispatch({ kind: 'insert', text: 'a' })
  const older = session.dispatch({ kind: 'complete' })
  const newer = session.dispatch({ kind: 'complete' })
  second.resolve(['apricot'])
  await newer
  first.resolve(['apple'])
  await older
  expect(session.model.snapshot.text).toBe('apricot')
  await session.dispatch({ kind: 'submit' })
  await read
})

test('incomplete input continues across newline with a secondary prompt', async () => {
  const session = new ReadSession({ isComplete: (text) => text.endsWith('done') })
  const read = session.read({ prompt: '$ ', secondaryPrompt: '> ' })
  await session.dispatch({ kind: 'insert', text: 'start' })
  await session.dispatch({ kind: 'submit' })
  expect(session.model.snapshot.text).toBe('start\n')
  expect(session.prompt).toEqual({ primary: '$ ', secondary: '> ' })
  await session.dispatch({ kind: 'insert', text: 'done' })
  await session.dispatch({ kind: 'submit' })
  expect(await read).toEqual({ kind: 'submit', text: 'start\ndone' })
})

test('edits and aborts invalidate asynchronous completeness checks', async () => {
  const complete = deferred<boolean>()
  const controller = new AbortController()
  const session = new ReadSession({ isComplete: () => complete.promise })
  const read = session.read({ prompt: '$ ', signal: controller.signal })
  await session.dispatch({ kind: 'insert', text: 'one' })
  const submit = session.dispatch({ kind: 'submit' })
  await session.dispatch({ kind: 'insert', text: ' two' })
  complete.resolve(true)
  await submit
  expect(session.active).toBe(true)
  expect(session.model.snapshot.text).toBe('one two')
  const rejected = expect(read).rejects.toMatchObject({ code: 'line-editor.READ_ABORTED' })
  controller.abort()
  await rejected
})

test('stale callback rejection is discarded after editing', async () => {
  let reject!: (cause: unknown) => void
  const result = new Promise<readonly string[]>((_resolve, fail) => {
    reject = fail
  })
  const session = new ReadSession({ complete: () => result })
  const read = session.read({ prompt: '$ ' })
  const completion = session.dispatch({ kind: 'complete' })
  await session.dispatch({ kind: 'insert', text: 'new' })
  reject('cancelled by host')
  await completion
  await session.dispatch({ kind: 'submit' })
  expect(await read).toEqual({ kind: 'submit', text: 'new' })
})

test('an already aborted signal leaves the editor ready for a later read', async () => {
  const controller = new AbortController()
  controller.abort()
  const session = new ReadSession()
  await expect(session.read({ prompt: '$ ', signal: controller.signal })).rejects.toMatchObject({
    code: 'line-editor.READ_ABORTED',
  })
  const read = session.read({ prompt: '$ ' })
  await session.dispatch({ kind: 'eof' })
  expect(await read).toEqual({ kind: 'end' })
})

test('clear keeps the editable text and cursor', async () => {
  const events: string[] = []
  const session = new ReadSession({}, (event) => {
    events.push(event.kind)
  })
  const read = session.read({ prompt: '$ ' })
  await session.dispatch({ kind: 'insert', text: 'keep' })
  await session.dispatch({ kind: 'left' })
  await session.dispatch({ kind: 'clear' })
  expect(session.model.snapshot).toMatchObject({ text: 'keep', cursor: 3 })
  expect(events.at(-1)).toBe('clear')
  await session.dispatch({ kind: 'submit' })
  await read
})

test('common prefixes cannot split a combining cluster or surrogate pair', async () => {
  const session = new ReadSession({ complete: () => ['éx', 'èx'] })
  const read = session.read({ prompt: '$ ' })
  await session.dispatch({ kind: 'complete' })
  expect(session.model.snapshot.text).toBe('')
  await session.dispatch({ kind: 'eof' })
  await read
})

test('an event-driven edit invalidates candidates before the next Tab', async () => {
  let calls = 0
  const session = new ReadSession(
    {
      complete: () => {
        calls++
        return ['hello', 'help']
      },
    },
    (event) => {
      if (event.kind === 'change' && session.model.snapshot.text === 'hel') {
        void session.dispatch({ kind: 'insert', text: 'x' })
      }
    },
  )
  const read = session.read({ prompt: '$ ' })
  await session.dispatch({ kind: 'insert', text: 'he' })
  await session.dispatch({ kind: 'complete' })
  expect(session.model.snapshot.text).toBe('helx')
  await session.dispatch({ kind: 'complete' })
  expect(calls).toBe(2)
  await session.dispatch({ kind: 'submit' })
  await read
})

test('a failed first-paint callback releases the pending read', async () => {
  let fail = true
  const session = new ReadSession({}, (event) => {
    if (event.kind === 'change' && fail) throw 'host paint failure'
  })
  await expect(session.read({ prompt: '$ ' })).rejects.toBe('host paint failure')
  expect(session.active).toBe(false)
  fail = false
  const read = session.read({ prompt: '$ ' })
  await session.dispatch({ kind: 'eof' })
  expect(await read).toEqual({ kind: 'end' })
})

test('a failing finish observer cannot leave a read unsettled or disposal active', async () => {
  const session = new ReadSession({}, (event) => {
    if (event.kind === 'finish') throw 'host finish failure'
  })
  const read = session.read({ prompt: '$ ' })
  await expect(session.dispatch({ kind: 'submit' })).rejects.toBe('host finish failure')
  expect(await read).toEqual({ kind: 'submit', text: '' })
  const disposed = session.read({ prompt: '$ ' })
  const rejected = expect(disposed).rejects.toMatchObject({ code: 'line-editor.DISPOSED' })
  expect(() => session.dispose()).toThrow('host finish failure')
  await rejected
  await expect(session.read({ prompt: '$ ' })).rejects.toMatchObject({
    code: 'line-editor.DISPOSED',
  })
})

test('shared history keeps each active session navigation and draft independent', async () => {
  const a = new ReadSession({ history: { entries: ['old'] } })
  const b = new ReadSession({ history: a.model.history })
  const first = a.read({ prompt: 'a' })
  await a.dispatch({ kind: 'insert', text: 'draft A' })
  await a.dispatch({ kind: 'previous' })
  const second = b.read({ prompt: 'b' })
  await b.dispatch({ kind: 'insert', text: 'draft B' })
  await b.dispatch({ kind: 'previous' })
  await a.dispatch({ kind: 'next' })
  expect(a.model.snapshot.text).toBe('draft A')
  await b.dispatch({ kind: 'next' })
  expect(b.model.snapshot.text).toBe('draft B')
  await a.dispatch({ kind: 'submit' })
  await b.dispatch({ kind: 'submit' })
  expect(await first).toEqual({ kind: 'submit', text: 'draft A' })
  expect(await second).toEqual({ kind: 'submit', text: 'draft B' })
  expect(a.model.history.entries).toEqual(['old', 'draft A', 'draft B'])
})

test('synchronous work cancellation cannot edit a disposed session or emit another change', async () => {
  const work = deferred<readonly string[]>()
  const events: string[] = []
  const session = new ReadSession(
    {
      complete: (_text, _cursor, signal) => {
        signal.addEventListener('abort', () => session.dispose(), { once: true })
        return work.promise
      },
    },
    (event) => {
      events.push(event.kind)
    },
  )
  const read = session.read({ prompt: '$' })
  const rejected = expect(read).rejects.toMatchObject({ code: 'line-editor.DISPOSED' })
  const completion = session.dispatch({ kind: 'complete' })
  await session.dispatch({ kind: 'insert', text: 'late' })
  expect(session.model.snapshot.text).toBe('')
  expect(events).toEqual(['change', 'finish'])
  work.resolve([])
  await completion
  await rejected
})

test('an interrupt output observer cannot finish a replacement read', async () => {
  const controller = new AbortController()
  let next: Promise<unknown> | undefined
  const session = new ReadSession({}, (event) => {
    if (event.kind !== 'output') return
    controller.abort()
    next = session.read({ prompt: 'second' })
  })
  const first = session.read({ prompt: 'first', signal: controller.signal })
  const aborted = expect(first).rejects.toMatchObject({ code: 'line-editor.READ_ABORTED' })
  await session.dispatch({ kind: 'interrupt' })
  expect(session.active).toBe(true)
  expect(session.prompt?.primary).toBe('second')
  await session.dispatch({ kind: 'insert', text: 'new' })
  await session.dispatch({ kind: 'submit' })
  expect(await next).toEqual({ kind: 'submit', text: 'new' })
  await aborted
})

test('screen clear preserves an in-flight completeness check and submission', async () => {
  const work = deferred<boolean>()
  let signal: AbortSignal | undefined
  const session = new ReadSession({
    isComplete: (_text, current) => {
      signal = current
      return work.promise
    },
  })
  const read = session.read({ prompt: '$' })
  await session.dispatch({ kind: 'insert', text: 'done' })
  const submit = session.dispatch({ kind: 'submit' })
  const snapshot = session.model.snapshot
  await session.dispatch({ kind: 'clear' })
  expect(session.model.snapshot).toEqual(snapshot)
  expect(signal?.aborted).toBe(false)
  work.resolve(true)
  await submit
  expect(session.active).toBe(false)
  expect(await read).toEqual({ kind: 'submit', text: 'done' })
})

test.each([
  ['e', 'é'],
  ['é', 'e'],
  ['👩', '👩‍💻'],
  ['👩‍💻', '👩'],
])('common-prefix completion preserves every candidate boundary for %j', async (first, second) => {
  const session = new ReadSession({ complete: () => [first, second] })
  const read = session.read({ prompt: '$' })
  await session.dispatch({ kind: 'complete' })
  expect(session.model.snapshot.text).toBe('')
  await session.dispatch({ kind: 'interrupt' })
  await read
})

test.each([{ values: [] }, { values: ['echo', 'ls'] }])(
  'Tab accepting reverse search emits change with candidates %j',
  async ({ values }) => {
    const events: string[] = []
    const session = new ReadSession(
      { history: { entries: ['echo'] }, complete: () => values },
      (event) => {
        events.push(event.kind)
      },
    )
    const read = session.read({ prompt: '$' })
    await session.dispatch({ kind: 'search' })
    const before = events.length
    await session.dispatch({ kind: 'complete' })
    expect(session.model.snapshot.search).toBeUndefined()
    expect(events.slice(before)).toEqual(['change'])
    await session.dispatch({ kind: 'submit' })
    await read
  },
)

test('Tab accepting search notifies before a failing completion callback', async () => {
  const events: string[] = []
  const session = new ReadSession(
    {
      history: { entries: ['echo'] },
      complete: () => {
        throw 'host completion failed'
      },
    },
    (event) => {
      events.push(event.kind)
    },
  )
  const read = session.read({ prompt: '$' })
  await session.dispatch({ kind: 'search' })
  const before = events.length
  await expect(session.dispatch({ kind: 'complete' })).rejects.toBe('host completion failed')
  expect(session.model.snapshot.search).toBeUndefined()
  expect(events.slice(before)).toEqual(['change'])
  await session.dispatch({ kind: 'submit' })
  await read
})

test('a synchronous abort listener keeps its newer completion and supersedes the old command', async () => {
  const first = deferred<readonly string[]>()
  const second = deferred<readonly string[]>()
  let nested: Promise<void> | undefined
  let signal: AbortSignal | undefined
  let calls = 0
  const session = new ReadSession({
    complete: (_text, _cursor, current) => {
      if (++calls === 1) {
        current.addEventListener(
          'abort',
          () => {
            nested = session.dispatch({ kind: 'complete' })
          },
          { once: true },
        )
        return first.promise
      }
      signal = current
      return second.promise
    },
  })
  const read = session.read({ prompt: '$' })
  const stale = session.dispatch({ kind: 'complete' })
  await session.dispatch({ kind: 'insert', text: 'obsolete' })
  expect(session.model.snapshot.text).toBe('')
  expect(signal?.aborted).toBe(false)
  second.resolve(['hello'])
  await nested
  expect(session.model.snapshot.text).toBe('hello')
  first.resolve(['old'])
  await stale
  await session.dispatch({ kind: 'submit' })
  expect(await read).toEqual({ kind: 'submit', text: 'hello' })
})

test.each([
  { operation: 'complete', rejected: false },
  { operation: 'complete', rejected: true },
  { operation: 'submit', rejected: false },
  { operation: 'submit', rejected: true },
] as const)(
  'stale success and rejection after abort and a new read: %j',
  async ({ operation, rejected }) => {
    let resolve!: (value: boolean | readonly string[]) => void
    let reject!: (cause: unknown) => void
    const work = new Promise<boolean | readonly string[]>((done, fail) => {
      resolve = done
      reject = fail
    })
    const options =
      operation === 'complete'
        ? { complete: () => work as Promise<readonly string[]> }
        : { isComplete: () => work as Promise<boolean> }
    const controller = new AbortController()
    const session = new ReadSession(options)
    const first = session.read({ prompt: 'old', signal: controller.signal })
    const aborted = expect(first).rejects.toMatchObject({ code: 'line-editor.READ_ABORTED' })
    await session.dispatch({ kind: 'insert', text: 'old' })
    const stale = session.dispatch({ kind: operation })
    controller.abort()
    await aborted
    const second = session.read({ prompt: 'new' })
    await session.dispatch({ kind: 'insert', text: 'new' })
    if (rejected) reject('late host failure')
    if (!rejected) resolve(operation === 'complete' ? ['overwrite'] : true)
    await stale
    expect(session.active).toBe(true)
    expect(session.model.snapshot.text).toBe('new')
    expect(session.prompt?.primary).toBe('new')
    const disposed = expect(second).rejects.toMatchObject({ code: 'line-editor.DISPOSED' })
    session.dispose()
    await disposed
  },
)

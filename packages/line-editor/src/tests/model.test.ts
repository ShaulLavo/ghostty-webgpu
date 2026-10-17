import { expect, test } from 'vitest'
import { EditModel } from '../model.js'
import { History } from '../history.js'

test('editing keeps combining, CJK and ZWJ graphemes whole with UTF16 cursor offsets', () => {
  const model = new EditModel()
  model.insert('a界é👩‍👩‍👧‍👦z')
  model.move('left')
  model.delete('backward')
  expect(model.snapshot).toMatchObject({ text: 'a界éz', cursor: 4 })
  model.move('left')
  model.delete('forward')
  expect(model.snapshot).toMatchObject({ text: 'a界z', cursor: 2 })
  model.insert('👨‍💻')
  expect(model.snapshot.cursor).toBe(7)
})

test('insertion resegments a combining mark and normalizes pasted newlines', () => {
  const model = new EditModel()
  model.insert('e')
  model.insert('́')
  model.move('left')
  expect(model.snapshot.cursor).toBe(0)
  model.insert('one\r\ntwo\rthree')
  expect(model.snapshot.text).toBe('one\ntwo\nthreeé')
})

test('word motion and backward/forward kills preserve a yank buffer', () => {
  const model = new EditModel()
  model.insert('one two three')
  model.move('word-left')
  expect(model.snapshot.cursor).toBe(8)
  model.kill('word')
  model.kill('start')
  expect(model.snapshot.text).toBe('three')
  model.yank()
  expect(model.snapshot.text).toBe('one two three')
  model.move('start')
  model.move('word-right')
  model.kill('end')
  expect(model.snapshot.text).toBe('one')
  model.yank()
  expect(model.snapshot.text).toBe('one two three')
})

test('history is bounded, ignores adjacent duplicates and restores an edited draft', () => {
  const history = new History({ limit: 2, entries: ['first', 'second'] })
  history.add('second')
  history.add('third')
  expect(history.entries).toEqual(['second', 'third'])
  const model = new EditModel(history)
  model.insert('draft')
  model.recall('previous')
  expect(model.snapshot.text).toBe('third')
  model.recall('previous')
  expect(model.snapshot.text).toBe('second')
  model.recall('previous')
  expect(model.snapshot.text).toBe('second')
  model.recall('next')
  expect(model.snapshot.text).toBe('third')
  model.recall('next')
  expect(model.snapshot.text).toBe('draft')
})

test('reverse search repeats backwards and can restore the original draft', () => {
  const history = new History({ entries: ['echo first', 'ls', 'echo last'] })
  const model = new EditModel(history)
  model.insert('draft')
  model.search()
  model.insert('echo')
  expect(model.snapshot).toMatchObject({ text: 'echo last', search: { query: 'echo' } })
  model.search()
  expect(model.snapshot.text).toBe('echo first')
  model.cancelSearch()
  expect(model.snapshot).toMatchObject({ text: 'draft', cursor: 5, search: undefined })
  model.search()
  model.insert('last')
  model.acceptSearch()
  expect(model.snapshot).toMatchObject({ text: 'echo last', search: undefined })
})

test('history persistence is host-owned and receives an immutable bounded snapshot', async () => {
  const saved: (readonly string[])[] = []
  const history = new History({
    limit: 2,
    store: {
      load: () => ['a'],
      save: (entries) => {
        saved.push(entries)
      },
    },
  })
  await history.load()
  history.add('b')
  history.add('c')
  await history.flush()
  expect(saved.at(-1)).toEqual(['b', 'c'])
  expect(Object.isFrozen(saved.at(-1))).toBe(true)
})

test('Home, End and kills operate on the current logical line', () => {
  const model = new EditModel()
  model.insert('one\ntwo\nthree')
  model.move('start')
  model.move('left')
  model.move('start')
  expect(model.snapshot.cursor).toBe(4)
  model.move('end')
  expect(model.snapshot.cursor).toBe(7)
  model.kill('end')
  expect(model.snapshot.text).toBe('one\ntwothree')
  model.kill('start')
  expect(model.snapshot.text).toBe('one\nthree')
})

test('pasted and recalled text cannot send terminal escape or C1 controls', () => {
  const model = new EditModel(new History({ entries: ['echo \x1b[31m\x9b'] }))
  model.recall('previous')
  expect(model.snapshot.text).toBe('echo [31m')
  model.insert('\x1b\x9b\x07')
  expect(model.snapshot.text).toBe('echo [31m')
})

test.each([NaN, Infinity, -1, 1.5])('history rejects an invalid bounded limit %s', (limit) => {
  expect(() => new History({ limit })).toThrow('The history limit must be a nonnegative integer.')
})

test('a zero history limit stores no entries', () => {
  const history = new History({ limit: 0, entries: ['old'] })
  history.add('new')
  expect(history.entries).toEqual([])
  const model = new EditModel(history)
  model.insert('draft')
  model.recall('previous')
  expect(model.snapshot.text).toBe('draft')
})

test('host saves serialize and a failed save does not block a later save', async () => {
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const saved: (readonly string[])[] = []
  const history = new History({
    store: {
      load: () => [],
      save: async (entries) => {
        saved.push(entries)
        if (entries.length === 1) {
          await blocked
          throw 'host store failure'
        }
      },
    },
  })
  history.add('a')
  const failed = expect(history.flush()).rejects.toBe('host store failure')
  history.add('b')
  await Promise.resolve()
  await Promise.resolve()
  expect(saved).toEqual([['a']])
  release()
  await failed
  await history.flush()
  expect(saved).toEqual([['a'], ['a', 'b']])
})

test('word movement crosses punctuation while CtrlW kills whitespace-delimited words', () => {
  const model = new EditModel()
  model.insert('echo 路径/file.txt')
  model.move('word-left')
  expect(model.snapshot.cursor).toBe(13)
  model.move('word-left')
  expect(model.snapshot.cursor).toBe(8)
  model.move('word-right')
  expect(model.snapshot.cursor).toBe(12)
  model.move('end')
  model.kill('word')
  expect(model.snapshot.text).toBe('echo ')
})

test('reverse-search results pass through the same plain-text boundary as recall', () => {
  const model = new EditModel(new History({ entries: ['echo \x1b[31m\x9b'] }))
  model.search()
  model.insert('echo')
  expect(model.snapshot.text).toBe('echo [31m')
})

test.each([{ entries: [] }, { entries: ['old'] }])(
  'Down before browsing preserves the draft with history %j',
  ({ entries }) => {
    const model = new EditModel(new History({ entries }))
    model.insert('echo unfinished')
    const before = model.snapshot
    model.recall('next')
    expect(model.snapshot).toEqual(before)
  },
)

test('Down at the newest position preserves a newly edited draft', () => {
  const model = new EditModel(new History({ entries: ['old'] }))
  model.insert('draft')
  model.recall('previous')
  model.recall('next')
  model.insert(' edited')
  model.recall('next')
  expect(model.snapshot.text).toBe('draft edited')
})

test('accepting reverse search transfers the selected entry and preserves the draft', () => {
  const model = new EditModel(new History({ entries: ['zero', 'echo first', 'echo last'] }))
  model.insert('draft')
  model.search()
  model.insert('echo')
  model.search()
  model.acceptSearch()
  model.recall('previous')
  expect(model.snapshot.text).toBe('zero')
  for (let index = 0; index < 3; index++) model.recall('next')
  expect(model.snapshot.text).toBe('draft')
})

test('refining and shortening reverse search keeps the older matching entry selected', () => {
  const model = new EditModel(new History({ entries: ['echo first', 'echo last'] }))
  model.search()
  model.insert('echo')
  model.search()
  model.insert(' ')
  expect(model.snapshot.text).toBe('echo first')
  model.delete('backward')
  expect(model.snapshot.text).toBe('echo first')
})

test('a shared history append and trim preserve an active navigation snapshot', () => {
  const history = new History({ limit: 2, entries: ['first', 'second'] })
  const model = new EditModel(history)
  model.insert('draft')
  model.recall('previous')
  history.add('third')
  expect(history.entries).toEqual(['second', 'third'])
  model.recall('previous')
  expect(model.snapshot.text).toBe('first')
  model.recall('next')
  expect(model.snapshot.text).toBe('second')
  model.recall('next')
  expect(model.snapshot.text).toBe('draft')
  model.recall('previous')
  expect(model.snapshot.text).toBe('third')
})

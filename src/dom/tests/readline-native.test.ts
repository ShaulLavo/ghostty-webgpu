import { afterEach, expect, it } from 'vitest'
import { TerminalSession } from '../../term/session.js'
import { ReadSession } from '../../../packages/line-editor/src/session.js'
import { ReadlineRenderer } from '../../../packages/line-editor/src/readline.js'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

async function native(columns: number, modes = ''): Promise<TerminalSession> {
  const terminal = await TerminalSession.create({
    appearance: {
      grid: { columns, rows: 6, cellWidth: 10, cellHeight: 20, pixelRatio: 1 },
    },
  })
  cleanups.push(() => terminal.dispose())
  terminal.write(`\x1b[?7h\x1b[20l${modes}`)
  return terminal
}

function state(terminal: TerminalSession) {
  const geometry = terminal.geometry()
  return {
    lines: terminal.readLines(0, 6),
    cursor: geometry.cursor,
    autowrap: geometry.autowrap,
    graphemeClustering: geometry.graphemeClustering,
  }
}

it('characterizes direct-native pending wrap, wide boundaries and zero-width units', async () => {
  const terminal = await native(6, '\x1b[?2027l')
  terminal.write('abcdef')
  console.log('direct full', JSON.stringify(state(terminal)))
  expect(terminal.geometry().cursor).toMatchObject({ x: 5, y: 0, pendingWrap: true })
  terminal.write('\u0301')
  console.log('direct full + combining', JSON.stringify(state(terminal)))
  expectCursor(terminal, 5, 0, true)
  expect(terminal.readLines(0, 1)[0]?.text).toBe('abcdef́')
  terminal.write('g')
  console.log('direct combining + next', JSON.stringify(state(terminal)))
  expectCursor(terminal, 1, 1)
  const wide = await native(4)
  wide.write('abc界z')
  console.log('direct wide', JSON.stringify(state(wide)))
  expect(wide.readLines(0, 2)).toEqual([
    { text: 'abc', wrapped: true },
    { text: '界z', wrapped: false },
  ])
  const zero = await native(6, '\x1b[?2027l')
  zero.write('\u0301')
  console.log('direct leading combining', JSON.stringify(state(zero)))
  expectCursor(zero, 0, 0)
  expect(zero.measureTexts(['́']).texts[0]?.units).toEqual([{ start: 0, end: 1, cells: 0 }])
})

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function editor(columns: number, prompt = '$ ', modes = '', seed = 'KEEP\r\n') {
  const terminal = await native(columns, modes)
  terminal.write(seed)
  const writes: string[] = []
  const errors: unknown[] = []
  let renderer: ReadlineRenderer
  const session = new ReadSession({}, (event) => renderer.handle(event))
  renderer = new ReadlineRenderer(
    {
      geometry: () => terminal.geometry(),
      measureTexts: (texts) => terminal.measureTexts(texts),
      write: (text) => {
        writes.push(typeof text === 'string' ? text : new TextDecoder().decode(text))
        return terminal.write(text)
      },
    },
    session,
    (cause) => errors.push(cause),
  )
  cleanups.push(() => {
    renderer.dispose()
    session.dispose()
  })
  async function settled(count: number): Promise<void> {
    await expect.poll(() => writes.length).toBe(count)
    await turn()
    expect(errors).toEqual([])
    console.log('editor settled', JSON.stringify({ writes, ...state(terminal) }))
  }
  console.log('editor origin', JSON.stringify(terminal.measureTexts([]).geometry))
  const pending = session.read({ prompt, secondaryPrompt: '> ' })
  void pending.then(
    (result) => renderer.finish(result),
    () => {},
  )
  await settled(1)
  async function edit(command: Parameters<ReadSession['dispatch']>[0]): Promise<void> {
    const count = writes.length + 1
    await session.dispatch(command)
    await settled(count)
  }
  return { terminal, session, renderer, pending, edit, settled, writes }
}

function expectCursor(terminal: TerminalSession, x: number, y: number, pendingWrap = false) {
  expect(terminal.geometry().cursor).toMatchObject({ x, y, pendingWrap })
}

function expectSame(actual: TerminalSession, expected: TerminalSession) {
  expect(state(actual)).toEqual(state(expected))
}

it('renders logical LF with primary and secondary prompts at column zero', async () => {
  const { terminal, session, edit } = await editor(12)
  await edit({ kind: 'insert', text: 'ab\ncd' })
  expect(session.model.snapshot.text).toBe('ab\ncd')
  expect(terminal.readLines(0, 3).map((line) => line.text)).toEqual(['KEEP', '$ ab', '> cd'])
  expectCursor(terminal, 4, 2)
  await edit({ kind: 'left' })
  expectCursor(terminal, 3, 2)
  await edit({ kind: 'insert', text: 'X' })
  expect(terminal.readLines(0, 3).map((line) => line.text)).toEqual(['KEEP', '$ ab', '> cXd'])
  expectCursor(terminal, 4, 2)
})

it('keeps exact-width pending wrap and earlier output through the next edit', async () => {
  const { terminal, edit } = await editor(6)
  const direct = await native(6)
  direct.write('KEEP\r\n$ abcd')
  await edit({ kind: 'insert', text: 'abcd' })
  expect.soft(state(terminal)).toEqual(state(direct))
  expect.soft(terminal.geometry().cursor).toMatchObject({ x: 5, y: 1, pendingWrap: true })
  await edit({ kind: 'insert', text: 'e' })
  direct.write('\r\x1b[J$ abcde')
  expectSame(terminal, direct)
  expect(terminal.readLines(0, 3).map((line) => line.text)).toEqual(['KEEP', '$ abcd', 'e'])
  expectCursor(terminal, 1, 2)
})

it('clears pending wrap when moving before the last printed unit', async () => {
  const { terminal, session, edit } = await editor(6)
  const direct = await native(6)
  direct.write('KEEP\r\n$ abcd\x1b[6G')
  await edit({ kind: 'insert', text: 'abcd' })
  await edit({ kind: 'left' })
  expectSame(terminal, direct)
  expectCursor(terminal, 5, 1)
  await edit({ kind: 'insert', text: 'X' })
  expect(session.model.snapshot).toMatchObject({ text: 'abcXd', cursor: 4 })
  direct.write('\r\x1b[J$ abcXd\x1b[1A\x1b[6G')
  expectSame(terminal, direct)
  expectCursor(terminal, 5, 1)
})

it('pre-wraps a wide native printing unit instead of splitting its cells', async () => {
  const { terminal, edit } = await editor(4, '', '', '')
  const direct = await native(4)
  direct.write('abc界z')
  await edit({ kind: 'insert', text: 'abc界z' })
  expectSame(terminal, direct)
  expectCursor(terminal, 3, 1)
  await edit({ kind: 'left' })
  direct.write('\x1b[3G')
  expectSame(terminal, direct)
  expectCursor(terminal, 2, 1)
})

it('keeps earlier output when a printing unit exceeds the one-column grid', async () => {
  const { terminal, edit } = await editor(1, '', '', 'K\r\n')
  const direct = await native(1)
  direct.write('K\r\n界')
  await edit({ kind: 'insert', text: '界' })
  expectSame(terminal, direct)
  expectCursor(terminal, 0, 1, true)
  await edit({ kind: 'insert', text: 'x' })
  direct.write('\r\x1b[J界x')
  expect(terminal.readLines(0, 1)[0]?.text).toBe('K')
  expectSame(terminal, direct)
  expectCursor(terminal, 0, 2, true)
})

it('does not consume pending wrap for a zero-width combining unit', async () => {
  const { terminal, edit } = await editor(6, '$ ', '\x1b[?2027l')
  const direct = await native(6, '\x1b[?2027l')
  direct.write('KEEP\r\n$ abcd\u0301')
  await edit({ kind: 'insert', text: 'abcd\u0301' })
  expectSame(terminal, direct)
  expectCursor(terminal, 5, 1, true)
  await edit({ kind: 'insert', text: 'e' })
  direct.write('\r\x1b[J$ abcd\u0301e')
  expectSame(terminal, direct)
})

it.each([
  {
    mode: 'h',
    text: '👩‍💻中é✈️',
    prefix: '👩‍💻中é',
    x: 7,
    units: [
      { start: 0, end: 5, cells: 2 },
      { start: 5, end: 6, cells: 2 },
      { start: 6, end: 8, cells: 1 },
      { start: 8, end: 10, cells: 2 },
    ],
  },
  {
    mode: 'l',
    text: '👩‍💻é✈️',
    prefix: '👩‍💻é',
    x: 7,
    units: [
      { start: 0, end: 2, cells: 2 },
      { start: 2, end: 3, cells: 0 },
      { start: 3, end: 5, cells: 2 },
      { start: 5, end: 6, cells: 1 },
      { start: 6, end: 7, cells: 0 },
      { start: 7, end: 8, cells: 1 },
      { start: 8, end: 9, cells: 0 },
    ],
  },
])(
  'uses native units and UTF16 cursor offsets with mode2027 $mode',
  async ({ mode, text, prefix, x, units }) => {
    const modes = `\x1b[?2027${mode}`
    const { terminal, session, edit } = await editor(12, '$ ', modes)
    expect(terminal.measureTexts([text]).texts[0]?.units).toEqual(units)
    const direct = await native(12, modes)
    direct.write(`KEEP\r\n$ ${text}`)
    await edit({ kind: 'insert', text })
    expectSame(terminal, direct)
    await edit({ kind: 'left' })
    expect(session.model.snapshot.cursor).toBe(prefix.length)
    direct.write(`\x1b[${x + 1}G`)
    expectSame(terminal, direct)
    expectCursor(terminal, x, 1)
  },
)

it('prints above an active multiline edit and submits logical LF without erasing earlier output', async () => {
  const { terminal, renderer, pending, edit, settled, writes } = await editor(12)
  await edit({ kind: 'insert', text: 'ab\ncd' })
  const count = writes.length
  renderer.print('output')
  await settled(count + 2)
  expect(terminal.readLines(0, 4).map((line) => line.text)).toEqual([
    'KEEP',
    'output',
    '$ ab',
    '> cd',
  ])
  expectCursor(terminal, 4, 3)
  await edit({ kind: 'submit' })
  await expect(pending).resolves.toEqual({ kind: 'submit', text: 'ab\ncd' })
  expect(terminal.readLines(0, 5).map((line) => line.text)).toEqual([
    'KEEP',
    'output',
    '$ ab',
    '> cd',
    '',
  ])
  expectCursor(terminal, 0, 4)
})

it('characterizes viewport-height overflow separately from bounded edit ownership', async () => {
  const { terminal, edit } = await editor(6)
  await edit({ kind: 'insert', text: 'x'.repeat(36) })
  const geometry = terminal.geometry()
  console.log('overflow outside scope', JSON.stringify({ geometry, ...state(terminal) }))
  expect(geometry.scrollbar.total).toBeGreaterThan(geometry.rows)
})

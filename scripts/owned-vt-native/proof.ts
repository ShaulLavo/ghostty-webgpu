import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { Native, type Receipt, type Snapshot } from './native.js'

export interface Command {
  readonly kind: string
  readonly text?: string
}
export interface Session {
  readonly model: { readonly snapshot: { readonly text: string; readonly cursor: number } }
  readonly prompt: { readonly primary: string; readonly secondary: string } | undefined
  read(options: { prompt: string; secondaryPrompt: string }): Promise<unknown>
  dispatch(command: Command): Promise<void>
  dispose(): void
}
export interface Owner {
  edit(command: Command): Promise<void>
  resize(cols: number, rows: number): Promise<void>
  printAbove(text: string): Promise<void>
  paint(): Promise<void>
}
export interface Case {
  name: string
  cols: number
  rows: number
  row: number
  mode: boolean
  text: string
  left: number
  prompt?: string
  secondary?: string
  resize?: [number, number]
  output?: string[]
  concurrent?: boolean
}

const cases: Case[] = [
  { name: 'ascii-midline', cols: 12, rows: 4, row: 0, mode: true, text: 'alpha', left: 2 },
  {
    name: 'hard-newline-secondary',
    cols: 12,
    rows: 5,
    row: 0,
    mode: true,
    text: 'first\nsecond',
    left: 3,
    secondary: '... ',
  },
  { name: 'softwrap-midline', cols: 6, rows: 5, row: 0, mode: true, text: 'abcdefghijk', left: 5 },
  {
    name: 'full-width-pending-wrap',
    cols: 6,
    rows: 4,
    row: 0,
    mode: true,
    text: 'abcdXY',
    left: 2,
  },
  {
    name: 'bottom-scroll-pending-wrap',
    cols: 6,
    rows: 4,
    row: 3,
    mode: true,
    text: 'abcdXY',
    left: 2,
  },
  {
    name: 'colored-wrapped-prompt',
    cols: 6,
    rows: 5,
    row: 0,
    mode: true,
    text: 'abcdXY',
    left: 2,
    prompt: '\x1b[31mcolored>\x1b[0m ',
  },
  {
    name: 'colored-prompt-boundary',
    cols: 4,
    rows: 4,
    row: 0,
    mode: true,
    text: 'XY',
    left: 2,
    prompt: '\x1b[31mABCD\x1b[0m',
  },
  {
    name: 'resize-reflow-midline',
    cols: 9,
    rows: 6,
    row: 0,
    mode: true,
    text: 'abcdefghijk',
    left: 5,
    resize: [5, 6],
  },
  {
    name: 'serialized-printAbove-bottom',
    cols: 8,
    rows: 6,
    row: 5,
    mode: true,
    text: 'abcde',
    left: 2,
    output: ['log one', 'log two'],
  },
  {
    name: 'concurrent-edit-printAbove-resize',
    cols: 10,
    rows: 6,
    row: 0,
    mode: true,
    text: 'abcde',
    left: 2,
    output: ['log'],
    resize: [7, 6],
    concurrent: true,
  },
]
for (const mode of [false, true]) {
  cases.push({
    name: `unicode-2027-${mode}`,
    cols: 14,
    rows: 5,
    row: 0,
    mode,
    text: 'a界é👩‍💻z',
    left: 2,
  })
  cases.push({
    name: `unicode-boundary-2027-${mode}`,
    cols: mode ? 6 : 8,
    rows: 5,
    row: 0,
    mode,
    text: '界👩‍💻XY',
    left: 2,
  })
  cases.push({
    name: `unicode-resize-bottom-2027-${mode}`,
    cols: 14,
    rows: 7,
    row: 6,
    mode,
    text: 'a界👩‍💻z\nend',
    left: 5,
    resize: [8, 7],
  })
}

function initial(test: Case): string {
  return `\x1b[?2027${test.mode ? 'h' : 'l'}\x1b[${test.row + 1};1H`
}

// This oracle only prints a known logical buffer in a test process; the owner never uses it.
function display(test: Case, text: string): string {
  const secondary = test.secondary ?? '> '
  return `\x1b[0m\x1b(B${test.prompt ?? '> '}${text.split('\n').join(`\r\n${secondary}`)}`
}

function rowText(snapshot: Snapshot): string[] {
  return snapshot.grid.map((row) =>
    row.cells.map((cell) => (cell.cp.length ? String.fromCodePoint(...cell.cp) : '·')).join(''),
  )
}

async function expected(
  native: Native,
  test: Case,
  text: string,
  cursor: number,
): Promise<{ snapshot: Snapshot; caret: Snapshot['cursor'] }> {
  const [cols, rows] = test.resize ?? [test.cols, test.rows]
  await native.create(cols, rows)
  await native.write(initial(test))
  for (const output of test.output ?? []) await native.write(`${output}\r\n`)
  await native.write(display(test, text.slice(0, cursor)))
  const prefix = await native.snapshot()
  await native.track(1)
  await native.write(
    text
      .slice(cursor)
      .split('\n')
      .join(`\r\n${test.secondary ?? '> '}`),
  )
  const snapshot = await native.snapshot()
  const point = await native.point(1)
  assert.ok(point, 'test oracle caret must remain in active screen')
  return { snapshot, caret: [point[0], point[1], prefix.cursor[2]] }
}

async function compare(
  native: Native,
  oracle: Native,
  session: Session,
  test: Case,
  receipt: Receipt,
  stage: string,
): Promise<Snapshot> {
  const model = session.model.snapshot
  const want = await expected(oracle, test, model.text, model.cursor)
  const actual = await native.snapshot()
  if (
    stage === 'before-next-insertion' &&
    (test.name.includes('boundary') || test.name.includes('pending-wrap'))
  )
    assert.equal(want.caret[2], true, 'boundary control must exercise native pending wrap')
  receipt({
    kind: 'observation',
    case: test.name,
    stage,
    logical: model,
    actualCursor: actual.cursor,
    expectedCursor: want.caret,
    actualRows: rowText(actual),
    expectedRows: rowText(want.snapshot),
  })
  assert.deepEqual(
    actual.grid,
    want.snapshot.grid,
    `${test.name}/${stage}: parsed cells, styles and native wraps`,
  )
  assert.deepEqual(
    actual.cursor,
    want.caret,
    `${test.name}/${stage}: native caret including pending wrap`,
  )
  return actual
}

async function insertion(
  native: Native,
  oracle: Native,
  owner: Owner,
  session: Session,
  test: Case,
  receipt: Receipt,
): Promise<void> {
  const before = await compare(native, oracle, session, test, receipt, 'before-next-insertion')
  const [x, y, wrap] = before.cursor
  const targetX = wrap ? 0 : x
  const targetY = wrap ? Math.min(y + 1, before.rows - 1) : y
  await native.write('#')
  const direct = await native.snapshot()
  receipt({
    kind: 'physical-next-insertion',
    case: test.name,
    target: [targetX, targetY],
    actual: direct.cursor,
    cell: direct.grid[targetY]!.cells[targetX],
  })
  assert.deepEqual(
    direct.grid[targetY]!.cells[targetX]!.cp,
    [35],
    'next native print must reach the logical caret',
  )
  const nextWrap = targetX === before.cols - 1
  assert.deepEqual(direct.cursor, [nextWrap ? targetX : targetX + 1, targetY, nextWrap])
  const { text, cursor } = session.model.snapshot
  await owner.edit({ kind: 'insert', text: '#' })
  assert.equal(session.model.snapshot.text, `${text.slice(0, cursor)}#${text.slice(cursor)}`)
  assert.equal(session.model.snapshot.cursor, cursor + 1)
  await compare(native, oracle, session, test, receipt, 'after-logical-next-insertion')
}

async function exercise(
  native: Native,
  oracle: Native,
  owner: Owner,
  session: Session,
  test: Case,
  receipt: Receipt,
): Promise<void> {
  await owner.paint()
  await owner.edit({ kind: 'insert', text: test.text })
  for (let index = 0; index < test.left; index++) await owner.edit({ kind: 'left' })
  if (test.concurrent) {
    await Promise.all([
      owner.edit({ kind: 'insert', text: '!' }),
      owner.printAbove(test.output![0]!),
      owner.resize(...test.resize!),
      owner.edit({ kind: 'left' }),
    ])
    assert.equal(session.model.snapshot.text, 'abc!de')
    assert.equal(session.model.snapshot.cursor, 3)
  }
  if (!test.concurrent && test.resize) await owner.resize(...test.resize)
  if (!test.concurrent) for (const output of test.output ?? []) await owner.printAbove(output)
  await insertion(native, oracle, owner, session, test, receipt)
}

// The red control deliberately leaves ReadSession disconnected from terminal output.
function disconnected(native: Native, session: Session): Owner {
  return {
    edit: (command) => session.dispatch(command),
    resize: (cols, rows) => native.resize(cols, rows),
    printAbove: async () => {},
    paint: async () => {},
  }
}

export async function viewportGuard(
  binary: string,
  session: Session,
  missing: boolean,
  receipt: Receipt,
  corrupt?: (session: Session, native: Native) => Promise<void>,
): Promise<void> {
  const native = new Native(binary, 'long-buffer/actual', receipt)
  void session.read({ prompt: '> ', secondaryPrompt: '> ' }).catch(() => {})
  try {
    await native.create(4, 2)
    const owner: Owner = missing
      ? disconnected(native, session)
      : new (await import('./owner.js')).OwnedRead(native, session, receipt)
    await owner.paint()
    await assert.rejects(
      owner.edit({ kind: 'insert', text: 'abcdefghijklmnopqrstuvwxyz' }),
      /long-buffer viewport/,
    )
    await corrupt?.(session, native)
    assert.equal(await native.point(0), null)
    const model = session.model.snapshot
    const snapshot = await native.snapshot()
    receipt({
      kind: 'viewport-limit',
      logical: model,
      native: snapshot,
      policy: 'stop when owned origin leaves active screen',
    })
    assert.equal(model.text, 'abcdefghijklmnopqrstuvwxyz', 'overflow must preserve retained text')
    assert.equal(model.cursor, 26, 'overflow must preserve retained cursor')
    assert.deepEqual(snapshot.cursor, [3, 1, true], 'overflow native cursor and pending wrap')
    await assert.rejects(owner.edit({ kind: 'insert', text: '#' }), /long-buffer viewport/)
    assert.deepEqual(
      session.model.snapshot,
      model,
      'failed queue must refuse subsequent logical edits',
    )
  } finally {
    session.dispose()
    await native.close()
  }
}

export async function runProof(
  binary: string,
  editor: string,
  missing: boolean,
  receipt: Receipt,
): Promise<void> {
  const { ReadSession } = await import(pathToFileURL(join(editor, 'src/session.ts')).href)
  let failures = 0
  for (const test of cases) {
    let operation: unknown
    const started: unknown[] = []
    const orderedReceipt: Receipt = (value) => {
      if (value.kind === 'operation-begin') {
        assert.equal(operation, undefined, 'whole owner operations must serialize')
        operation = value.id
        started.push(value.name)
      }
      if (value.kind === 'operation-end') {
        assert.equal(operation, value.id)
        operation = undefined
      }
      receipt({ case: test.name, ...value })
    }
    const native = new Native(binary, `${test.name}/actual`, receipt)
    const oracle = new Native(binary, `${test.name}/oracle`, receipt)
    const session: Session = new ReadSession()
    const pending = session.read({
      prompt: test.prompt ?? '> ',
      secondaryPrompt: test.secondary ?? '> ',
    })
    void pending.catch(() => {})
    try {
      await native.create(test.cols, test.rows)
      await native.write(initial(test))
      const owner: Owner = missing
        ? disconnected(native, session)
        : new (await import('./owner.js')).OwnedRead(native, session, orderedReceipt)
      await exercise(native, oracle, owner, session, test, receipt)
      assert.equal(operation, undefined)
      if (test.concurrent)
        assert.deepEqual(started.slice(-5), [
          'edit/insert',
          'printAbove',
          'resize',
          'edit/left',
          'edit/insert',
        ])
      receipt({ kind: 'case', case: test.name, outcome: 'PASS' })
      console.log(`PASS ${test.name}`)
    } catch (error) {
      failures++
      if (missing) {
        const model = session.model.snapshot
        const want = await expected(oracle, test, model.text, model.cursor)
        const before = await native.snapshot()
        await native.write('#')
        const after = await native.snapshot()
        receipt({
          kind: 'red-next-insertion',
          case: test.name,
          logical: model,
          expectedCaret: want.caret,
          actualBefore: before.cursor,
          actualAfter: after.cursor,
          actualRows: rowText(after),
        })
      }
      receipt({ kind: 'case', case: test.name, outcome: 'FAIL', error: String(error) })
      console.log(`FAIL ${test.name}: ${String(error).slice(0, 220)}`)
    } finally {
      session.dispose()
      await native.close()
      await oracle.close()
    }
  }
  try {
    await viewportGuard(binary, new ReadSession(), missing, receipt)
    receipt({ kind: 'case', case: 'long-buffer-fails-closed', outcome: 'PASS' })
    console.log('PASS long-buffer-fails-closed')
  } catch (error) {
    failures++
    receipt({
      kind: 'case',
      case: 'long-buffer-fails-closed',
      outcome: 'FAIL',
      error: String(error),
    })
    console.log(`FAIL long-buffer-fails-closed: ${String(error).slice(0, 220)}`)
  }
  console.log(
    `Native owned-VT proof: ${cases.length + 1 - failures}/${cases.length + 1} passed; missing-renderer=${missing}`,
  )
  assert.equal(failures, 0, 'native owner proof has failing cases')
}

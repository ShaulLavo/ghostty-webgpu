import { afterEach, expect, it, vi } from 'vitest'
import { GhosttyRuntime } from '../core/runtime.js'
import { GhosttyRenderState } from '../core/render-state.js'
import { GhosttyTerminal } from '../core/terminal.js'
import { retainDisplayedFrame } from '../render/shared/displayed-frame.js'

const runtimes: GhosttyRuntime[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const execution of executions.splice(0)) execution.dispose()
  for (const runtime of runtimes.splice(0)) runtime.dispose()
})

async function native() {
  const runtime = await GhosttyRuntime.create()
  runtimes.push(runtime)
  const terminal = runtime.createTerminal({ columns: 20, rows: 3 })
  const state = runtime.createRenderState(terminal)
  return { runtime, terminal, state }
}

it('memoizes owned revisions, shares a store identity, and rejects retired or discarded tokens', async () => {
  const { runtime, terminal, state } = await native()
  terminal.write('first')
  state.update()
  const first = state[retainDisplayedFrame]()
  first.accept()
  first.readTextRows()
  const revisions = first.readTextRevisions()
  expect(Object.isFrozen(revisions)).toBe(true)
  expect(revisions).toHaveLength(3)
  const reads = vi.spyOn(runtime.bridge, 'readRetainedRevisions')
  expect(first.readTextRevisions()).toBe(revisions)
  expect(reads).not.toHaveBeenCalled()
  state.acknowledge()
  terminal.write('\rsecond')
  state.update()
  const pending = state[retainDisplayedFrame]()
  expect(pending.revisionSource).toBe(first.revisionSource)
  pending.readTextRevisions()
  pending.discard()
  expect(() => pending.readTextRevisions()).toThrow('token has retired')
  const next = state[retainDisplayedFrame]()
  next.accept()
  expect(() => first.readTextRevisions()).toThrow('token has retired')
  state.dispose()
  expect(() => next.readTextRevisions()).toThrow('token has retired')
})

import { LocalTerminalExecution } from '../dom/execution-local.js'
import { calculateTerminalFittedFont } from '../dom/fit.js'
import { submittedFrame, type TerminalSubmittedSnapshot } from '../dom/submitted-frame.js'
import { TerminalSession } from '../term/session.js'
import type { NativeDisplayedFrame } from '../core/displayed-frame.js'
import type { RendererTextFrameSnapshot, RendererTextFrameRow } from '../render/shared/types.js'
import type { WorkerMessage } from './protocol.js'
import { RevisionPublisher } from './revision-publisher.js'
import { RevisionReception, receiveRevisionFrame } from './revision-reception.js'
import { TerminalWorkerError } from './structured-errors.js'

type Frame = Extract<WorkerMessage, { type: 'frame' }>
const executions: LocalTerminalExecution[] = []

async function actor(columns = 20, rows = 10, runtime?: GhosttyRuntime) {
  runtime ??= await GhosttyRuntime.create()
  if (!runtimes.includes(runtime)) runtimes.push(runtime)
  const session = await TerminalSession.create<Event>({
    runtime: { kind: 'borrowed', runtime },
    appearance: { grid: { columns, rows } },
  })
  const execution = new LocalTerminalExecution(session)
  executions.push(execution)
  execution.commitLayout(
    calculateTerminalFittedFont(
      execution.appearance.font,
      { advanceWidth: 8, fontAscent: 10, fontDescent: 3 },
      2,
    ),
    { top: 1, right: 2, bottom: 3, left: 4 },
  )
  const state = session.renderState
  const terminal: unknown = Reflect.get(session, 'terminal')
  if (!(state instanceof GhosttyRenderState) || !(terminal instanceof GhosttyTerminal))
    throw new Error('Expected real native state')
  return { runtime, session, state, terminal, execution }
}
type Actor = Awaited<ReturnType<typeof actor>>

function expectFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return
  expect(Object.isFrozen(value)).toBe(true)
  for (const child of Object.values(value)) expectFrozen(child)
}

class Stream {
  readonly publisher = new RevisionPublisher()
  readonly reception: RevisionReception
  readonly reference = new Map<string, RendererTextFrameRow>()
  private shadow?: TerminalSubmittedSnapshot
  private previous?: TerminalSubmittedSnapshot
  private readonly owned: {
    readonly projection: RendererTextFrameSnapshot
    readonly copy: RendererTextFrameSnapshot
  }[] = []
  constructor(readonly identity = { terminal: 'test', generation: 1 }) {
    this.reception = new RevisionReception(identity)
  }
  encode(actor: Actor, nativeFrame?: NativeDisplayedFrame) {
    const { state, execution } = actor
    state.update()
    const liveRows = structuredClone(state.readTextRows())
    const frame = nativeFrame ?? state[retainDisplayedFrame]()
    frame.readTextRows()
    state.acknowledge()
    frame.accept()
    const projection = {
      renderHeld: state.renderHeld,
      cursor: state.readCursor(),
      paintedCursor: undefined,
      rows: liveRows,
    }
    execution.submit({ ...projection, nativeFrame: frame })
    const metadata = execution.submittedFrame!
    const submission = {
      nativeRevision: metadata.nativeRevision,
      snapshotVersion: metadata.snapshotVersion,
      layout: metadata.layout,
      grid: metadata.grid,
      font: metadata.font,
      padding: metadata.padding,
      theme: metadata.theme,
      selection: metadata.selection,
      scrollbar: metadata.scrollbar,
    }
    this.shadow = submittedFrame(this.shadow, { ...submission, snapshot: projection })
    const message: Frame = {
      ...this.identity,
      type: 'frame',
      control: this.shadow.frame,
      output: 0,
      base: this.shadow.frame - 1,
      frame: this.shadow.frame,
      mouseTracking: execution.mouseTracking,
      submission,
      snapshot: {
        renderHeld: projection.renderHeld,
        cursor: projection.cursor,
        paintedCursor: undefined,
      },
      ...this.publisher.encode(frame),
    }
    return {
      message: structuredClone(message),
      shadow: structuredClone(this.shadow),
      projection,
      frame,
    }
  }
  apply(encoded: ReturnType<Stream['encode']>) {
    const { message, projection, shadow } = encoded
    const decoded = receiveRevisionFrame(this.reception, this.previous, message)
    expect(decoded.projection).toStrictEqual(projection)
    expect(decoded.summary).toStrictEqual(shadow)
    expectFrozen(decoded)
    expect(this.reception.size).toBeLessThanOrEqual(message.submission.grid.rows)
    expect(Reflect.get(this.publisher, 'published').size).toBeLessThanOrEqual(
      new Set(message.revisions).size,
    )
    const prefix = `${message.terminal}/${message.generation}/${message.store}/`
    for (const row of message.content) {
      const key = prefix + row.revision
      const old = this.reference.get(key)
      if (old)
        expect(row).toEqual({
          revision: row.revision,
          text: old.text,
          cells: old.cells,
          continuations: old.continuations,
        })
      this.reference.set(key, {
        y: -1,
        text: row.text,
        cells: row.cells,
        continuations: row.continuations,
      })
    }
    expect(decoded.projection.rows).toStrictEqual(
      message.revisions.map((revision, y) => ({ ...this.reference.get(prefix + revision)!, y })),
    )
    for (const retained of this.owned) expect(retained.projection).toStrictEqual(retained.copy)
    this.owned.push({ projection: decoded.projection, copy: structuredClone(decoded.projection) })
    this.previous = decoded.summary
    return decoded
  }
  publish(actor: Actor, frame?: NativeDisplayedFrame) {
    return this.apply(this.encode(actor, frame))
  }
}

it('matches eager live-row shadows through dense Unicode redraws, scrolls, edits, style changes and resize', async () => {
  const a = await actor(40, 10)
  const stream = new Stream()
  const line = (n: number) => `\r\n${n} 界 e\u0301 🧑‍💻 𝑓`
  a.execution.write(Array.from({ length: 10 }, (_, i) => line(i)).join(''))
  stream.publish(a)
  a.execution.write(line(19))
  stream.publish(a)
  for (const count of [1, 7]) {
    a.execution.write(Array.from({ length: count }, (_, i) => line(i + 20)).join(''))
    const encoded = stream.encode(a)
    expect(encoded.message.content).toHaveLength(count)
    stream.apply(encoded)
  }
  a.execution.write('\x1b[1;1H\x1b[31m')
  const styleOnly = stream.encode(a)
  expect(styleOnly.message.content).toHaveLength(0)
  stream.apply(styleOnly)
  a.execution.write('Q')
  stream.publish(a)
  a.execution.resize({ rows: 12 })
  stream.publish(a)
  a.execution.resize({ columns: 45 })
  stream.publish(a)
})

it('preserves cell-only edits with equal row text, including continuation flags', async () => {
  const a = await actor()
  const stream = new Stream()
  a.execution.write('a b')
  const first = stream.publish(a)
  a.execution.write('\r\x1b[2Ka\x1b[Cb')
  const second = stream.encode(a)
  expect(second.projection.rows[0]!.text).toBe(first.projection.rows[0]!.text)
  expect(second.projection.rows[0]!.cells[1]).toBe('')
  expect(first.projection.rows[0]!.cells[1]).toBe(' ')
  expect(second.message.content.some((row) => row.revision === second.message.revisions[0])).toBe(
    true,
  )
  stream.apply(second)
  a.execution.write('\r界')
  const wide = stream.publish(a)
  expect(wide.projection.rows[0]!.continuations[1]).toBe(true)
})

it('rebuilds clean resubmissions against the last host summary, not native previous rows', async () => {
  const a = await actor()
  const stream = new Stream()
  a.execution.write('before')
  stream.publish(a)
  a.execution.write('\rafter')
  const changed = stream.encode(a)
  expect(stream.apply(changed).summary.rowPatches).toHaveLength(1)
  const clean = stream.encode(a, changed.frame)
  expect(clean.message.content).toHaveLength(0)
  expect(stream.apply(clean).summary.rowPatches).toHaveLength(0)
})

it('isolates runtimes, terminals and unequal-cadence stores with overlapping numeric revisions', async () => {
  const a = await actor()
  const b = await actor()
  const c = await actor(20, 10, a.runtime)
  const streams = [
    new Stream({ terminal: 'a', generation: 1 }),
    new Stream({ terminal: 'b', generation: 1 }),
    new Stream({ terminal: 'c', generation: 1 }),
  ]
  const actors = [a, b, c]
  for (let i = 0; i < 18; i += 1) {
    const index = i % 3
    actors[index]!.execution.write(`\r${index}:${i}`)
    streams[index]!.publish(actors[index]!)
  }
  expect(streams[0]!.reception).not.toBe(streams[1]!.reception)
  for (const stream of streams) {
    stream.reception.clear()
    stream.publisher.clear()
    expect(stream.reception.size).toBe(0)
  }
})

it('supports overlapping captures on two subscribers and retires only the disposed subscriber', async () => {
  const a = await actor()
  const second = a.runtime.createRenderState(a.terminal)
  a.execution.write('overlapping')
  a.state.update()
  second.update()
  const firstFrame = a.state[retainDisplayedFrame]()
  const otherFrame = second[retainDisplayedFrame]()
  expect(firstFrame.revisionSource).not.toBe(otherFrame.revisionSource)
  firstFrame.accept()
  otherFrame.accept()
  const publisher = new RevisionPublisher()
  publisher.encode(firstFrame)
  const other = new RevisionPublisher()
  const content = other.encode(otherFrame)
  a.state.dispose()
  expect(() => firstFrame.readTextRevisions()).toThrow('token has retired')
  expect(other.encode(otherFrame).revisions).toBe(content.revisions)
  second.dispose()
})

it('drains delayed immutable messages, prunes a long accepted history and keeps owned snapshots', async () => {
  const a = await actor()
  const stream = new Stream()
  stream.publish(a)
  for (let batch = 0; batch < 5; batch += 1) {
    const queued = Array.from({ length: 5 }, (_, i) => {
      a.execution.write(`batch ${batch}:${i}\r\n`)
      return stream.encode(a)
    })
    for (const message of queued) stream.apply(message)
  }
  stream.reception.clear()
  stream.publisher.clear()
  expect(stream.reception.size).toBe(0)
  expect(Reflect.get(stream.publisher, 'published').size).toBe(0)
  expect(Reflect.get(stream.publisher, 'last')).toBeUndefined()
})

it('does not publish abandoned capture content when a retry reuses its numbers', async () => {
  const a = await actor()
  const stream = new Stream()
  stream.publish(a)
  a.execution.write('abandoned')
  a.state.update()
  const pending = a.state[retainDisplayedFrame]()
  const numbers = pending.readTextRevisions()
  pending.readTextRows()
  pending.discard()
  a.execution.write('\r\x1b[2Kretry 界')
  const retry = stream.encode(a)
  expect(retry.message.revisions).toEqual(numbers)
  expect(retry.message.content[0]!.text).toContain('retry')
  stream.apply(retry)
})

it('stages malformed store increments atomically, then accepts overlapping revisions in the valid new store', async () => {
  const a = await actor()
  const b = await actor()
  const stream = new Stream()
  a.execution.write('first store')
  stream.publish(a)
  b.execution.write('second store')
  const increment = stream.encode(b)
  const store = Reflect.get(stream.reception, 'store')
  const pin = Reflect.get(stream.reception, 'pin')
  const before = Array.from(pin)
  const malformed = structuredClone(increment.message)
  Reflect.set(malformed, 'content', [])
  expect(() =>
    receiveRevisionFrame(stream.reception, Reflect.get(stream, 'previous'), malformed),
  ).toThrow(TerminalWorkerError)
  expect(Reflect.get(stream.reception, 'store')).toBe(store)
  expect(Reflect.get(stream.reception, 'pin')).toBe(pin)
  expect(Array.from(pin)).toEqual(before)
  expect(increment.message.revisions).toEqual(Array.from(pin.keys()))
  expect(increment.message.store).toBe(2)
  stream.apply(increment)
  expect(Reflect.get(stream.reception, 'store')).toBe(2)
})

function rejectedOperation(name: string): string {
  if (name.includes('store')) return 'frame.store'
  if (name === 'wrong terminal' || name === 'wrong generation') return 'frame.identity'
  if (name === 'wrong base' || name === 'wrong frame') return 'frame.base'
  if (name === 'bad font' || name === 'bad theme' || name === 'bad cursor') return 'frame.metadata'
  if (name.includes('content') && name !== 'missing content') return 'frame.content'
  if (name.includes('cells') || name.includes('continuations')) return 'frame.content'
  return 'frame.revision'
}

function sparse(length: number): unknown[] {
  const values = Array.from({ length }, () => undefined)
  for (let i = 0; i < values.length; i += 1) delete values[i]
  return values
}

function alteredContent(message: Frame, first: unknown): unknown[] {
  const values: unknown[] = [first]
  return values.concat(message.content.slice(1))
}

it.each([
  ['empty revisions', (m: Frame) => ({ ...m, revisions: [] })],
  ['short revisions', (m: Frame) => ({ ...m, revisions: m.revisions.slice(1) })],
  ['long revisions', (m: Frame) => ({ ...m, revisions: m.revisions.concat([1]) })],
  ['zero store', (m: Frame) => ({ ...m, store: 0 })],
  ['skipped store', (m: Frame) => ({ ...m, store: 3 })],
  ['invalid revision', (m: Frame) => ({ ...m, revisions: [0].concat(m.revisions.slice(1)) })],
  ['fractional revision', (m: Frame) => ({ ...m, revisions: [1.5].concat(m.revisions.slice(1)) })],
  ['negative revision', (m: Frame) => ({ ...m, revisions: [-1].concat(m.revisions.slice(1)) })],
  [
    'overflow revision',
    (m: Frame) => ({ ...m, revisions: [Number.MAX_SAFE_INTEGER + 1].concat(m.revisions.slice(1)) }),
  ],
  ['missing content', (m: Frame) => ({ ...m, content: m.content.slice(1) })],
  ['duplicate content', (m: Frame) => ({ ...m, content: [m.content[0]].concat(m.content) })],
  [
    'unused content',
    (m: Frame) => ({ ...m, content: m.content.concat([{ ...m.content[0]!, revision: 999 }]) }),
  ],
  [
    'unreferenced revision',
    (m: Frame) => ({
      ...m,
      content: [{ ...m.content[0]!, revision: 999 }].concat(m.content.slice(1)),
    }),
  ],
  [
    'duplicate revision',
    (m: Frame) => ({ ...m, content: [m.content[0]!, m.content[0]!].concat(m.content.slice(2)) }),
  ],
  ['malformed content', (m: Frame) => ({ ...m, content: [null] })],
  [
    'bad continuations',
    (m: Frame) => ({ ...m, content: alteredContent(m, { ...m.content[0]!, continuations: [] }) }),
  ],
  [
    'bad cells',
    (m: Frame) => ({ ...m, content: alteredContent(m, { ...m.content[0]!, cells: [2] }) }),
  ],
  [
    'sparse cells',
    (m: Frame) => ({
      ...m,
      content: alteredContent(m, { ...m.content[0]!, cells: sparse(m.submission.grid.columns) }),
    }),
  ],
  [
    'sparse continuations',
    (m: Frame) => ({
      ...m,
      content: alteredContent(m, {
        ...m.content[0]!,
        continuations: sparse(m.submission.grid.columns),
      }),
    }),
  ],
  ['bad font', (m: Frame) => ({ ...m, submission: { ...m.submission, font: { settings: null } } })],
  ['bad theme', (m: Frame) => ({ ...m, submission: { ...m.submission, theme: null } })],
  ['bad cursor', (m: Frame) => ({ ...m, snapshot: { cursor: {} } })],
  ['wrong terminal', (m: Frame) => ({ ...m, terminal: 'foreign' })],
  ['wrong generation', (m: Frame) => ({ ...m, generation: 2 })],
  ['wrong base', (m: Frame) => ({ ...m, base: 1 })],
  ['wrong frame', (m: Frame) => ({ ...m, frame: 3 })],
] as const)('rejects %s without changing the exact reception state', async (_name, mutate) => {
  const a = await actor()
  const stream = new Stream()
  const encoded = stream.encode(a)
  const pin = Reflect.get(stream.reception, 'pin')
  expect(() => receiveRevisionFrame(stream.reception, undefined, mutate(encoded.message))).toThrow(
    TerminalWorkerError,
  )
  expect(() => receiveRevisionFrame(stream.reception, undefined, mutate(encoded.message))).toThrow(
    expect.objectContaining({ operation: rejectedOperation(_name), code: 'protocol' }),
  )
  expect(Reflect.get(stream.reception, 'pin')).toBe(pin)
  expect(Reflect.get(stream.reception, 'store')).toBe(0)
  stream.apply(encoded)
})

it('rejects redundant content and backward epochs without disturbing the current pin', async () => {
  const a = await actor()
  const b = await actor()
  const stream = new Stream()
  const first = stream.encode(a)
  stream.apply(first)
  const next = stream.encode(a, first.frame)
  const previous = Reflect.get(stream, 'previous')
  expect(() =>
    receiveRevisionFrame(stream.reception, previous, {
      ...next.message,
      content: first.message.content,
    }),
  ).toThrow(TerminalWorkerError)
  stream.apply(next)
  const changed = stream.encode(b)
  stream.apply(changed)
  const final = stream.encode(b, changed.frame)
  expect(() =>
    receiveRevisionFrame(stream.reception, Reflect.get(stream, 'previous'), {
      ...final.message,
      store: 1,
    }),
  ).toThrow(TerminalWorkerError)
  stream.apply(final)
})

it('preserves lone UTF-16 surrogates through structured clone', async () => {
  const a = await actor()
  const stream = new Stream()
  const encoded = stream.encode(a)
  const message = structuredClone(encoded.message)
  const row = message.content[0]!
  const cells = row.cells.slice()
  cells[0] = '\ud800x'
  const result = receiveRevisionFrame(
    stream.reception,
    undefined,
    structuredClone({
      ...message,
      content: alteredContent(message, { ...row, text: '\ud800x', cells }),
    }),
  )
  expect(result.projection.rows[0]!.text).toBe('\ud800x')
  expect(result.projection.rows[0]!.cells[0]).toBe('\ud800x')
  expectFrozen(result)
})

it('accepts the last exact native revision and rejects exhaustion without changing reception', async () => {
  const a = await actor(20, 2)
  const stream = new Stream()
  stream.publish(a)
  const store = Reflect.get(a.state, 'displayedFrames')
  const handle = Reflect.get(Reflect.get(Reflect.get(store, 'frames'), 'current'), 'handle')
  a.runtime.memory.view.setBigUint64(handle + 32, BigInt(Number.MAX_SAFE_INTEGER) - 1n, true)
  a.execution.write('last')
  const last = stream.encode(a)
  expect(last.message.revisions).toContain(Number.MAX_SAFE_INTEGER)
  stream.apply(last)
  const pin = Reflect.get(stream.reception, 'pin')
  a.execution.write('\rnext')
  expect(() => stream.encode(a)).toThrow('retain_frame')
  expect(Reflect.get(stream.reception, 'pin')).toBe(pin)
})

it('rejects publisher epoch exhaustion and clears every retained reference', async () => {
  const a = await actor()
  const stream = new Stream()
  stream.publish(a)
  Reflect.set(stream.publisher, 'store', Number.MAX_SAFE_INTEGER)
  const b = await actor()
  expect(() => stream.encode(b)).toThrow(TerminalWorkerError)
  stream.publisher.clear()
  expect(Reflect.get(stream.publisher, 'source')).toBeUndefined()
  expect(Reflect.get(stream.publisher, 'last')).toBeUndefined()
})

it('keeps two retained stores on the same native terminal independent through unequal cadence', async () => {
  const a = await actor()
  const state = a.runtime.createRenderState(a.terminal)
  const b = { ...a, state }
  const first = new Stream({ terminal: 'subscriber-a', generation: 1 })
  const second = new Stream({ terminal: 'subscriber-b', generation: 1 })
  try {
    a.execution.write('same terminal')
    const initialA = first.encode(a)
    const initialB = second.encode(b)
    expect(initialA.message.revisions).toEqual(initialB.message.revisions)
    expect(initialA.frame.revisionSource).not.toBe(initialB.frame.revisionSource)
    first.apply(initialA)
    second.apply(initialB)
    for (let i = 0; i < 6; i += 1) {
      a.execution.write(`\rsubscriber update ${i}`)
      first.publish(a)
      if (i % 2 === 0) second.publish(b)
    }
    first.reception.clear()
    first.publisher.clear()
    second.publish(b)
    expect(second.reception.size).toBeGreaterThan(0)
  } finally {
    state.dispose()
  }
})

it('retains the BiDi render-state wrapper and owns its selected-cell projection', async () => {
  const runtime = await GhosttyRuntime.create()
  runtimes.push(runtime)
  const session = await TerminalSession.create<Event>({
    bidi: true,
    runtime: { kind: 'borrowed', runtime },
    appearance: { grid: { columns: 20, rows: 3 } },
  })
  const execution = new LocalTerminalExecution(session)
  executions.push(execution)
  execution.write('ab שלום cd')
  session.selectionPress({
    viewport: { x: 3, y: 0 },
    position: { x: 35, y: 5 },
    repeatDistance: 10,
    repeatIntervalNanoseconds: 500_000_000n,
    timeNanoseconds: 1_000_000_000n,
  })
  session.selectionDrag({
    viewport: { x: 1, y: 0 },
    position: { x: 15, y: 5 },
    geometry: { columns: 20, cellWidth: 10, paddingLeft: 0, screenHeight: 160 },
  })
  session.selectionRelease({ x: 1, y: 0 })
  expect(session.getSelection()).toBe('b ם')
  const source = session.renderState
  source.update()
  expect(
    source
      .readRows()[0]!
      .cells.filter((cell) => cell.selected)
      .map((cell) => cell.x),
  ).toEqual([1, 2, 6])
  const retain = Reflect.get(source, retainDisplayedFrame)
  expect(typeof retain).toBe('function')
  if (typeof retain !== 'function') throw new Error('BiDi wrapper must forward retained frames')
  const frame: NativeDisplayedFrame = retain.call(source, { full: true })
  const expected = structuredClone(
    source.readRows().map((row) => row.cells.map((cell) => cell.selected)),
  )
  frame.accept()
  const revisions = frame.readTextRevisions()
  execution.clearSelection()
  source.update()
  expect(frame.readRows().map((row) => row.cells.map((cell) => cell.selected))).toEqual(expected)
  expect(frame.readTextRevisions()).toBe(revisions)
  source.acknowledge()
})

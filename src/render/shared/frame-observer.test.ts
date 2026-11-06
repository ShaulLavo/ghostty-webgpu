import { expect, it, vi } from 'vitest'
import { RenderStateDirty } from '../../core/abi.js'
import type { RenderStateSource } from './types.js'
import { FrameObserver } from './frame-observer.js'
import type { NativeDisplayedFrame } from '../../core/displayed-frame.js'
import type { DisplayedFrameSource, DisplayedTextFrame } from './displayed-frame.js'
import {
  captureDisplayedRows,
  displayedRows,
  capturedSubmission,
  captureSubmission,
  retainDisplayedFrame,
  attachCanvasImage,
  observeDisplayedFrame,
} from './displayed-frame.js'
import { CanvasImageRelay } from '../../dom/canvas-image.js'

const state: RenderStateSource = {
  acknowledge: () => 0,
  readCursor: () => ({ visible: false, blinking: false, passwordInput: false, style: 'block' }),
  readRows: () => [],
  update: () => RenderStateDirty.False,
}

it('invalidates an accepted publication when its image is resized', () => {
  const calls: string[] = []
  const observer = new FrameObserver({ rows: 1, onRowsChanged: () => calls.push('rows') })
  const frame = observer.capture(state, state.readCursor(), undefined, [0])
  frame.accept()
  observer.resize(2)
  frame.notify()
  expect(calls).toEqual([])
})

it('stops the public observer chain after a callback resizes the image', () => {
  const calls: string[] = []
  const observer = new FrameObserver({
    rows: 1,
    onFrame: () => {
      calls.push('frame')
      observer.resize(2)
    },
    onTextFrame: () => calls.push('text'),
    onRowsChanged: () => calls.push('rows'),
  })
  observer.emit(state, state.readCursor(), undefined, [0])
  expect(calls).toEqual(['frame'])
})

function fixture(onError: (cause: unknown) => void = () => {}) {
  const calls: string[] = []
  const relay = new CanvasImageRelay(onError)
  const observer = new FrameObserver({
    rows: 1,
    [attachCanvasImage]: () => relay.attach(),
    [observeDisplayedFrame]: () => calls.push('displayed'),
    onFrame: () => calls.push('frame'),
    onTextFrame: () => calls.push('text'),
    onRowsPainted: () => calls.push('painted'),
    onRowsChanged: () => calls.push('rows'),
  })
  observer.activateCanvasImage()
  const capture = () => observer.capture(state, state.readCursor(), undefined, [0], [])
  const publish = () => {
    const frame = capture()
    frame.accept()
    frame.notify('drawn')
  }
  return { calls, relay, observer, capture, publish }
}

it('delivers drawn images before the unchanged deterministic public observer order', () => {
  const f = fixture()
  f.relay.subscribe(() => f.calls.push('image'))
  f.publish()
  expect(f.calls).toEqual(['image', 'frame', 'displayed', 'text', 'painted', 'rows'])
})

it.each(['unaccepted', 'discarded', 'stale', 'retained', 'disposed', 'resized'] as const)(
  'does not deliver an image for a %s publication',
  (kind) => {
    const f = fixture()
    const image = vi.fn()
    f.relay.subscribe(image)
    const frame = f.capture()
    if (kind === 'discarded') frame.discard()
    if (kind !== 'unaccepted') frame.accept()
    if (kind === 'stale') f.capture().discard()
    if (kind === 'disposed') f.observer.dispose()
    if (kind === 'resized') f.observer.resize(2)
    frame.notify(kind === 'retained' ? 'retained' : 'drawn')
    expect(image).not.toHaveBeenCalled()
    if (kind !== 'retained') expect(f.calls).toEqual([])
  },
)

it.each(['dispose', 'resize', 'relay-dispose'] as const)(
  'checks lifetime between listeners after %s',
  (action) => {
    const f = fixture()
    f.relay.subscribe(() => {
      f.calls.push('first')
      if (action === 'dispose') f.observer.dispose()
      if (action === 'resize') f.observer.resize(2)
      if (action === 'relay-dispose') {
        f.relay.dispose()
        f.observer.dispose()
      }
    })
    f.relay.subscribe(() => f.calls.push('second'))
    f.publish()
    expect(f.calls).toEqual(['first'])
  },
)

it('does not deliver a listener removed before its turn', () => {
  const f = fixture()
  f.relay.subscribe(() => second.kind === 'subscription' && second.dispose())
  const second = f.relay.subscribe(() => f.calls.push('second'))
  f.publish()
  expect(f.calls).toEqual(['frame', 'displayed', 'text', 'painted', 'rows'])
})

it('stops the outer publication after a nested publication with two listeners', () => {
  const f = fixture()
  let nested = false
  f.relay.subscribe(() => {
    f.calls.push(nested ? 'nested-first' : 'outer-first')
    if (nested) return
    nested = true
    f.publish()
  })
  f.relay.subscribe(() => f.calls.push('nested-second'))
  f.publish()
  expect(f.calls).toEqual([
    'outer-first',
    'nested-first',
    'nested-second',
    'frame',
    'displayed',
    'text',
    'painted',
    'rows',
  ])
})

it('isolates listener throws and rejected promises and reports each once', async () => {
  const error = new Error('capture')
  const onError = vi.fn()
  const f = fixture(onError)
  f.relay.subscribe(() => {
    throw error
  })
  f.relay.subscribe(() => Promise.reject(error))
  f.relay.subscribe(() => f.calls.push('last'))
  expect(f.publish).not.toThrow()
  await Promise.resolve()
  expect(onError.mock.calls).toEqual([[error], [error]])
  expect(f.calls).toEqual(['last', 'frame', 'displayed', 'text', 'painted', 'rows'])
})

it.each(['dispose', 'resize', 'nested'] as const)(
  'rechecks publication after an error hook causes %s',
  (action) => {
    let failed = false
    const f = fixture(() => {
      if (action === 'dispose') f.observer.dispose()
      if (action === 'resize') f.observer.resize(2)
      if (action === 'nested') f.publish()
      throw new Error('error hook')
    })
    f.relay.subscribe(() => {
      if (failed) return
      failed = true
      throw new Error('listener')
    })
    f.relay.subscribe(() => f.calls.push('second'))
    expect(f.publish).not.toThrow()
    expect(f.calls).toEqual(
      action === 'nested' ? ['second', 'frame', 'displayed', 'text', 'painted', 'rows'] : [],
    )
  },
)

it('tracks participation by live publisher, including replacement and failed acquisition', () => {
  const relay = new CanvasImageRelay(() => {})
  expect(relay.subscribe(() => {})).toEqual({ kind: 'unsupported' })
  const old = relay.attach()
  const next = relay.attach()
  old.dispose()
  const image = vi.fn()
  expect(relay.subscribe(image).kind).toBe('subscription')
  old.notify(() => true)
  expect(image).not.toHaveBeenCalled()
  next.notify(() => true)
  expect(image).toHaveBeenCalledTimes(1)
  next.dispose()
  expect(relay.subscribe(image).kind).toBe('unsupported')
})

it('adopts a promise-like listener result once and preserves a falsy rejection', async () => {
  let reads = 0
  const onError = vi.fn()
  const f = fixture(onError)
  f.relay.subscribe(() => ({
    get then() {
      reads += 1
      return (_resolve: (value: unknown) => void, reject: (cause: unknown) => void) => reject(false)
    },
  }))
  expect(f.publish).not.toThrow()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(onError.mock.calls).toEqual([[false]])
  expect(reads).toBe(1)
})

it('captures private readers and submission before demand and native retention', () => {
  const calls: string[] = []
  const reader = Object.freeze({ readRows: () => [] })
  const record = Object.freeze({ value: 'captured' })
  const native: NativeDisplayedFrame = {
    token: 1,
    accept: () => calls.push('accept'),
    discard: () => calls.push('discard'),
    readRows: () => [],
    readTextRows: () => [],
    readPreviousTextRows: () => [],
  }
  const source: RenderStateSource & DisplayedFrameSource = {
    ...state,
    [captureDisplayedRows]() {
      expect(this).toBe(source)
      calls.push('reader')
      return reader
    },
    [retainDisplayedFrame]() {
      calls.push('retain')
      return native
    },
  }
  const frames: DisplayedTextFrame[] = []
  const observer = new FrameObserver({
    rows: 1,
    retainDisplayedText: true,
    [captureSubmission]: () => {
      calls.push('submission')
      return record
    },
    needsFrameRows: () => {
      calls.push('demand')
      return false
    },
    onFrame: (snapshot) => {
      expect(Object.getOwnPropertySymbols(snapshot)).toEqual([])
      calls.push('public')
    },
    [observeDisplayedFrame]: (snapshot) => {
      frames.push(snapshot)
      calls.push('displayed')
    },
  })
  const prepared = observer.capture(source, source.readCursor(), undefined, [0])
  expect(calls).toEqual(['reader', 'submission', 'demand', 'retain'])
  prepared.accept()
  expect(calls).not.toContain('accept')
  prepared.notify()
  expect(calls).toEqual([
    'reader',
    'submission',
    'demand',
    'retain',
    'public',
    'accept',
    'displayed',
  ])
  expect(frames[0]![displayedRows]).toBe(reader)
  expect(frames[0]![capturedSubmission]).toBe(record)
  observer.dispose()
})

it('carries private metadata on text callbacks only when a capability exists', () => {
  const record = Object.freeze({})
  const reader = Object.freeze({ readRows: () => [] })
  const source: RenderStateSource & DisplayedFrameSource = {
    ...state,
    [captureDisplayedRows]: () => reader,
  }
  const snapshots: DisplayedTextFrame[] = []
  const observer = new FrameObserver({
    rows: 1,
    onTextFrame: (snapshot) => snapshots.push(snapshot),
    [captureSubmission]: () => record,
  })
  observer.emit(source, source.readCursor(), undefined, [0])
  expect(snapshots[0]![displayedRows]).toBe(reader)
  expect(snapshots[0]![capturedSubmission]).toBe(record)
  const plain = new FrameObserver({ rows: 1, onTextFrame: (snapshot) => snapshots.push(snapshot) })
  plain.emit(state, state.readCursor(), undefined, [0])
  expect(Object.getOwnPropertySymbols(snapshots[1]!)).toEqual([])
  const capture = vi.fn(() => record)
  const rowsOnly = new FrameObserver({ rows: 1, onFrame: () => {}, [captureSubmission]: capture })
  rowsOnly.emit(source, source.readCursor(), undefined, [0])
  expect(capture).not.toHaveBeenCalled()
  observer.dispose()
  plain.dispose()
  rowsOnly.dispose()
})

it('discards an unpublished native capture when onFrame throws and recovers with a full capture', () => {
  const accept = vi.fn()
  const discard = vi.fn()
  const options: Array<{ full?: boolean } | undefined> = []
  const source: RenderStateSource & DisplayedFrameSource = {
    ...state,
    [retainDisplayedFrame]: (input) => {
      options.push(input)
      return {
        token: options.length,
        accept,
        discard,
        readRows: () => [],
        readTextRows: () => [],
        readPreviousTextRows: () => [],
      }
    },
  }
  let fail = true
  const observer = new FrameObserver({
    rows: 1,
    retainDisplayedText: true,
    [observeDisplayedFrame]: () => {},
    onFrame: () => {
      if (fail) throw new Error('before publication')
    },
  })
  expect(() => observer.emit(source, source.readCursor(), undefined, [0])).toThrow(
    'before publication',
  )
  expect(accept).not.toHaveBeenCalled()
  expect(discard).toHaveBeenCalledTimes(1)
  fail = false
  observer.emit(source, source.readCursor(), undefined, [0])
  expect(options).toEqual([{ full: true }, { full: true }])
  expect(accept).toHaveBeenCalledTimes(1)
  observer.dispose()
})

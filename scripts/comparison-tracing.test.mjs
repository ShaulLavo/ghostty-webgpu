import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ComparisonTracing } from '../bench/comparison-tracing.ts'

function rendererBoundary() {
  const metrics = { submittedFrames: 0, zigFrames: 0 }
  const builder = { build: () => 0, clearGlyphs() {} }
  const pass = {
    resources: { cellPipeline: {}, glyphPipeline: {} },
    uploadFrame: () => 0,
    submit: () => {},
  }
  return {
    metrics,
    builder,
    textPass: pass,
    device: { queue: {} },
    scheduler: {},
    atlasTextures: { sync: () => {} },
    notifyWrite: () => {},
    rowsToRebuild: () => [],
    drawZigFrame(mode) {
      if (mode === 'clean') return true
      builder.build()
      if (mode === 'failed') throw new Error('Native build failed')
      pass.uploadFrame(builder, [])
      pass.submit()
      metrics.submittedFrames++
      metrics.zigFrames++
      return true
    },
    drawFrame(mode) {
      this.drawZigFrame(mode)
    },
  }
}

function recordedCounters(draw, readTextRows) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location')
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { search: '?trace' },
  })
  try {
    const tracing = new ComparisonTracing()
    const renderer = rendererBoundary()
    const state = {
      update() {},
      readRows: () => [],
      ...(readTextRows ? { readTextRows } : {}),
      acknowledge() {},
      createFrameBuilder: () => renderer.builder,
    }
    tracing.native(
      3,
      {
        handle: 1,
        size: { columns: 10 },
        runtime: { exports: { ghostty_terminal_vt_write: () => {} } },
        write() {},
      },
      state,
    )
    tracing.renderer(3, renderer)
    state.createFrameBuilder()
    renderer.drawFrame('zig')
    tracing.begin()
    draw(renderer, state)
    return tracing.end().counters
  } finally {
    if (previous) Object.defineProperty(globalThis, 'location', previous)
    else Reflect.deleteProperty(globalThis, 'location')
  }
}

function total(counters, operation) {
  return counters
    .filter((counter) => counter.operation === operation)
    .reduce((sum, counter) => sum + counter.value, 0)
}

test('WebGL native uploads attribute changed bytes exactly once for native records', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location')
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { search: '?trace' },
  })
  try {
    const tracing = new ComparisonTracing()
    const pass = {
      syncAtlas() {},
      uploadFrame: () => 2,
      submit() {},
    }
    const renderer = {
      backend: 'webgl2',
      metrics: { submittedFrames: 0, zigFrames: 0 },
      scheduler: {},
      state: { pass },
      notifyWrite() {},
      drawFrame() {},
      drawZigFrame() {},
      rowsToRebuild() {},
    }
    tracing.nativeRenderer(3, renderer)
    tracing.begin()
    const ranges = [{ cell: { byteLength: 64 }, glyph: { byteLength: 96 } }]
    pass.uploadFrame({}, ranges)
    renderer.drawFrame()
    const { counters, spans } = tracing.end()
    assert.equal(total(counters, 'buffersWritten'), 2)
    assert.equal(total(counters, 'bufferBytes'), 160)
    assert.equal(spans.filter(({ operation }) => operation === 'uploadFrame').length, 1)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'location', previous)
    else Reflect.deleteProperty(globalThis, 'location')
  }
})

test('clean Zig draws count no built or submitted frames', () => {
  const counters = recordedCounters((renderer) => renderer.drawFrame('clean'))
  assert.equal(total(counters, 'zigBuilds'), 0)
  assert.equal(total(counters, 'submissions'), 0)
  assert.equal(total(counters, 'frames'), 0)
  assert.equal(total(counters, 'zigFrames'), 0)
})

test('Zig frame counts match builds and submissions across clean draws and trace windows', () => {
  const counters = recordedCounters((renderer) => {
    renderer.drawFrame('zig')
    renderer.drawFrame('clean')
    renderer.drawFrame('zig')
    renderer.drawFrame('clean')
  })
  assert.equal(total(counters, 'zigBuilds'), 2)
  assert.equal(total(counters, 'submissions'), 2)
  assert.equal(total(counters, 'zigFrames'), 2)
  assert.equal(total(counters, 'frames'), 2)
  assert(counters.every((counter) => counter.terminal === 3))
})

test('failed native builds submit no frame', () => {
  const counters = recordedCounters((renderer) => {
    assert.throws(() => renderer.drawFrame('failed'), /Native build failed/)
  })
  assert.equal(total(counters, 'zigBuilds'), 1)
  assert.equal(total(counters, 'submissions'), 0)
  assert.equal(total(counters, 'frames'), 0)
})

test('text extraction counters preserve lazy arrays while older runtimes remain traceable', () => {
  const row = {
    y: 0,
    text: 'owned text',
    get cells() {
      assert.fail('Tracing must preserve lazy cell strings')
    },
    get continuations() {
      assert.fail('Tracing must preserve lazy continuation flags')
    },
  }
  const counters = recordedCounters(
    (_, state) => state.readTextRows(),
    () => [row, row],
  )
  assert.equal(total(counters, 'textRowsCopied'), 2)
  assert.equal(total(counters, 'textCellsCopied'), 20)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ComparisonTracing } from '../bench/comparison-tracing.ts'

function rendererBoundary() {
  const metrics = { submittedFrames: 0, zigFrames: 0, jsFallbackFrames: 0 }
  const builder = { build: () => 0 }
  const pass = {
    resources: { cellPipeline: {}, glyphPipeline: {} },
    upload: () => 0,
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
    rebuildRows: () => [],
    drawZigFrame(mode) {
      if (mode === 'clean') return true
      builder.build()
      if (mode === 'fallback' || mode === 'fallback-clean') return false
      pass.uploadFrame(builder, [])
      pass.submit()
      metrics.submittedFrames++
      metrics.zigFrames++
      return true
    },
    drawFrame(mode) {
      if (this.drawZigFrame(mode) || mode === 'fallback-clean') return
      pass.upload(undefined, [])
      pass.submit()
      metrics.submittedFrames++
      metrics.jsFallbackFrames++
    },
  }
}

function recordedCounters(draw) {
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
      acknowledge() {},
      createFrameBuilder: () => renderer.builder,
    }
    tracing.native(
      3,
      { handle: 1, runtime: { exports: { ghostty_terminal_vt_write: () => {} } }, write() {} },
      state,
    )
    tracing.renderer(3, renderer)
    state.createFrameBuilder()
    renderer.drawFrame('zig')
    tracing.begin()
    draw(renderer)
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

test('WebGL native uploads attribute changed bytes exactly once for both producers', () => {
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
      upload(frame, ranges) {
        return this.uploadFrame(frame, ranges)
      },
      submit() {},
    }
    const renderer = {
      backend: 'webgl2',
      metrics: { submittedFrames: 0, zigFrames: 0, jsFallbackFrames: 0 },
      scheduler: {},
      state: { pass },
      notifyWrite() {},
      drawFrame() {},
      drawZigFrame() {},
      rowsToRebuild() {},
      rebuildRows() {},
    }
    tracing.nativeRenderer(3, renderer)
    tracing.begin()
    const ranges = [{ cell: { byteLength: 64 }, glyph: { byteLength: 96 } }]
    pass.uploadFrame({}, ranges)
    pass.upload({}, ranges)
    renderer.drawFrame()
    const { counters, spans } = tracing.end()
    assert.equal(total(counters, 'buffersWritten'), 4)
    assert.equal(total(counters, 'bufferBytes'), 320)
    assert.equal(spans.filter(({ operation }) => operation === 'uploadFrame').length, 2)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'location', previous)
    else Reflect.deleteProperty(globalThis, 'location')
  }
})

test('archived JS-only WebGL records uploads without requiring native boundaries', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location')
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { search: '?trace' },
  })
  try {
    const tracing = new ComparisonTracing()
    const pass = { syncAtlas() {}, upload: () => 2, submit() {} }
    const metrics = { submittedFrames: 0, zigFrames: 0, jsFallbackFrames: 0 }
    const renderer = {
      backend: 'webgl2',
      metrics,
      scheduler: {},
      state: { pass },
      notifyWrite() {},
      rowsToRebuild() {},
      rebuildRows() {},
      drawFrame() {
        pass.upload({}, [
          { cell: { byteOffset: 0, byteLength: 64 }, glyph: { byteOffset: 0, byteLength: 96 } },
          { cell: { byteOffset: 64, byteLength: 64 }, glyph: { byteOffset: 96, byteLength: 96 } },
        ])
        pass.submit()
        metrics.submittedFrames++
      },
    }
    tracing.nativeRenderer(3, renderer)
    tracing.begin()
    renderer.drawFrame()
    const { counters, spans } = tracing.end()
    assert.equal(total(counters, 'buffersWritten'), 2)
    assert.equal(total(counters, 'bufferBytes'), 320)
    assert.equal(total(counters, 'submissions'), 1)
    assert.equal(total(counters, 'frames'), 1)
    assert.equal(total(counters, 'zigFrames'), 0)
    assert.equal(total(counters, 'zigFallbackFrames'), 0)
    assert.equal(spans.filter(({ operation }) => operation === 'upload').length, 1)
    assert.equal(spans.filter(({ operation }) => operation === 'drawZigFrame').length, 0)
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
  assert.equal(total(counters, 'zigFallbackFrames'), 0)
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

test('Zig fallbacks count only frames submitted by the JS path', () => {
  const counters = recordedCounters((renderer) => {
    renderer.drawFrame('fallback-clean')
    renderer.drawFrame('fallback')
    renderer.drawFrame('clean')
  })
  assert.equal(total(counters, 'zigBuilds'), 2)
  assert.equal(total(counters, 'submissions'), 1)
  assert.equal(total(counters, 'zigFallbackFrames'), 1)
  assert.equal(total(counters, 'zigFrames'), 0)
  assert.equal(total(counters, 'frames'), 1)
})

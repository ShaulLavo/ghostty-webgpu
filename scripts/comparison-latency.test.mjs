import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { presentationLatency, presentationResult, latencyEndpoint } from './comparison-latency.mjs'

const recorded = JSON.parse(
  await readFile(new URL('./fixtures/comparison-presentation.json', import.meta.url)),
)

const linuxRecorded = JSON.parse(
  await readFile(
    new URL('./fixtures/comparison-presentation-linux-headless-shell.json', import.meta.url),
  ),
)

test('operation and correlation failures retain their raw presentation phase and stay rejected', () => {
  for (const failure of ['operation', 'correlation']) {
    const phase = structuredClone(recorded.phase)
    phase.trace = 'retained.trace.json.gz'
    if (failure === 'operation') phase.error = 'Presented green glyph timed out'
    if (failure === 'correlation') phase.records.spans = []
    const run = {}
    assert.throws(() => presentationResult(run, phase, recorded.events))
    assert.throws(() => presentationResult(run, phase, undefined))
    assert.equal(run.latencyFailure, phase)
    assert.equal(run.latency, undefined)
    assert.equal(run.latencyFailure.trace, phase.trace)
  }
})

test('successful presentation qualification returns the measured endpoint without failure evidence', () => {
  const phase = { ...recorded.phase, trace: 'success.trace.json.gz' }
  const run = {}
  assert.deepEqual(presentationResult(run, phase, recorded.events), {
    ...presentationLatency(phase, recorded.events),
    trace: phase.trace,
  })
  assert.equal(run.latencyFailure, undefined)
})

test('recorded render identity selects presentation feedback, independently of PNG capture time', () => {
  const result = presentationLatency(recorded.phase, recorded.events)
  assert.equal(result.endpoint, latencyEndpoint)
  assert.ok(Math.abs(result.write[0] - recorded.expected) < 0.001)
  const changed = structuredClone(recorded.phase)
  changed.sample.captures[0].timestamp += 100
  assert.deepEqual(presentationLatency(changed, recorded.events).write, result.write)
})

test('unrelated presentations and absent terminal render frames fail closed', () => {
  const events = structuredClone(recorded.events)
  events.find((event) => event.name === 'AnimationFrame::Presentation').args.id = 'another-frame'
  assert.throws(() => presentationLatency(recorded.phase, events), /presentation feedback/)
  const phase = structuredClone(recorded.phase)
  phase.records.spans = []
  assert.throws(() => presentationLatency(phase, recorded.events))
})

test('a deferred no-submission renderer callback cannot become the glyph endpoint', () => {
  const fixture = structuredClone(recorded)
  const parse = fixture.phase.records.spans.find((span) => span.category === 'parse')
  const frame = fixture.phase.records.spans.find((span) => span.operation === 'drawFrame')
  const start = parse.end
  const end = (parse.end + frame.start) / 2
  fixture.phase.records.spans.unshift({
    terminal: 0,
    operation: 'drawFrame',
    category: 'js',
    start,
    end,
    self: end - start,
  })
  const marker = fixture.events.find((event) => event.name === 'compare/begin')
  const offset = marker.ts / 1000 - marker.args.data.startTime
  fixture.events.push(
    {
      name: 'AnimationFrame',
      ph: 'b',
      id2: { local: 'no-op' },
      args: { id: 'no-op-frame' },
      ts: (start + offset) * 1000,
      pid: marker.pid,
      tid: marker.tid,
    },
    {
      name: 'AnimationFrame',
      ph: 'e',
      id2: { local: 'no-op' },
      ts: (end + offset) * 1000,
      pid: marker.pid,
      tid: marker.tid,
    },
    {
      name: 'AnimationFrame::Presentation',
      args: { id: 'no-op-frame' },
      ts: (end + offset + 1) * 1000,
      pid: marker.pid,
      tid: marker.tid,
    },
  )
  const result = presentationLatency(fixture.phase, fixture.events)
  assert.ok(Math.abs(result.write[0] - recorded.expected) < 0.001)
  assert.notEqual(result.presentations[0].animationId, 'no-op-frame')
})

test('latency requires parse, GPU submission, and input echo evidence', () => {
  for (const category of ['parse', 'commands']) {
    const phase = structuredClone(recorded.phase)
    phase.records.spans = phase.records.spans.filter((span) => span.category !== category)
    assert.throws(() => presentationLatency(phase, recorded.events))
  }
  const phase = structuredClone(recorded.phase)
  phase.sample.captures[0].operation = 'input'
  assert.throws(() => presentationLatency(phase, recorded.events), /echo receipt/)
})

test('recorded Linux headless-shell write and input select their own submission presentations', () => {
  assert.equal(linuxRecorded.browserChannel, 'chromium-headless-shell')
  const result = presentationLatency(linuxRecorded.phase, linuxRecorded.events)
  for (const operation of ['write', 'input']) {
    assert.equal(result[operation].length, 1)
    assert.ok(Math.abs(result[operation][0] - linuxRecorded.expected[operation]) < 0.001)
  }
  assert.notEqual(result.presentations[0].animationId, result.presentations[1].animationId)
  for (const presentation of result.presentations)
    assert.ok(presentation.milliseconds >= presentation.renderBoundaryEnd)
})

test('matching frame identity with positive feedback before GPU submission fails closed', () => {
  for (const operation of ['write', 'input']) {
    const fixture = structuredClone(linuxRecorded)
    const result = presentationLatency(fixture.phase, fixture.events)
    const selected = result.presentations.find(
      (presentation) => presentation.operation === operation,
    )
    const capture = fixture.phase.sample.captures.find((sample) => sample.operation === operation)
    const begin = fixture.events.find((event) => event.name === 'compare/begin')
    const offset = begin.ts / 1000 - begin.args.data.startTime
    const feedback = fixture.events.find(
      (event) =>
        event.name === 'AnimationFrame::Presentation' && event.args.id === selected.animationId,
    )
    const started = capture.started - fixture.phase.records.timeOrigin
    feedback.ts = (started + offset + selected.renderBoundaryEnd / 2) * 1000
    assert.ok(feedback.ts / 1000 - offset - started > 0)
    assert.throws(
      () => presentationLatency(fixture.phase, fixture.events),
      /terminal render boundary end/,
    )
  }
})

test('presentation feedback exactly at GPU submission end is accepted', () => {
  const fixture = structuredClone(recorded)
  const begin = fixture.events.find((event) => event.name === 'compare/begin')
  const offset = begin.ts / 1000 - begin.args.data.startTime
  const submit = fixture.phase.records.spans.find((span) => span.operation === 'submit')
  const feedback = fixture.events.find((event) => event.name === 'AnimationFrame::Presentation')
  feedback.ts = (submit.end + offset) * 1000
  submit.end = feedback.ts / 1000 - offset
  const result = presentationLatency(fixture.phase, fixture.events)
  assert.equal(result.presentations[0].milliseconds, result.presentations[0].renderBoundaryEnd)
})

test('recorded xterm WebGL submission selects its own Chrome frame presentation', async () => {
  const fixture = JSON.parse(
    await readFile(new URL('./fixtures/comparison-presentation-xterm.json', import.meta.url)),
  )
  const result = presentationLatency(fixture.phase, fixture.events)
  assert.ok(Math.abs(result.write[0] - fixture.expected) < 0.001)
})

function paintedFixture(backend, operation, frameOperation = 'drawFrame') {
  const fixture = structuredClone(recorded)
  fixture.phase.records.ownership = [{ terminal: 0, backend }]
  fixture.phase.records.spans.find((span) => span.operation === 'drawFrame').operation =
    frameOperation
  fixture.phase.records.spans.find((span) => span.operation === 'submit').operation = operation
  return fixture
}

test('canvas and DOM join actual terminal paint to its own compositor frame identity', () => {
  for (const [backend, operation, frame] of [
    ['canvas2d', 'paint', 'drawFrame'],
    ['dom', 'replaceWith', 'drawFrame'],
    ['ghostty-web', 'renderLine', 'render'],
    ['xterm-dom', 'replaceChildren', 'renderRows'],
    ['webgl2', 'submit', 'drawFrame'],
  ]) {
    const fixture = paintedFixture(backend, operation, frame)
    const result = presentationLatency(fixture.phase, fixture.events)
    assert.ok(Math.abs(result.write[0] - recorded.expected) < 0.001)
    assert.equal(result.presentations[0].renderBoundary, operation)
    assert.ok(result.presentations[0].milliseconds >= result.presentations[0].renderBoundaryEnd)
    const unrelated = structuredClone(fixture.events)
    unrelated.find((event) => event.name === 'AnimationFrame::Presentation').args.id = 'unrelated'
    assert.throws(() => presentationLatency(fixture.phase, unrelated), /presentation feedback/)
    fixture.phase.records.spans = fixture.phase.records.spans.filter(
      (span) => span.category !== 'commands',
    )
    assert.throws(() => presentationLatency(fixture.phase, fixture.events), /committed row paint/)
  }
})

test('software frames require their renderer-specific commit and reject incidental work', () => {
  for (const [backend, actual] of [
    ['canvas2d', 'paint'],
    ['dom', 'replaceWith'],
    ['ghostty-web', 'renderLine'],
    ['xterm-dom', 'replaceChildren'],
  ]) {
    for (const incidental of ['clearDirty', 'fillRect', 'createRow', 'submit']) {
      const fixture = paintedFixture(backend, incidental)
      assert.throws(() => presentationLatency(fixture.phase, fixture.events), /committed row paint/)
    }
    const fixture = paintedFixture(backend, actual)
    fixture.phase.records.spans.find((span) => span.operation === actual).terminal = 1
    assert.throws(() => presentationLatency(fixture.phase, fixture.events), /committed row paint/)
  }
})

test('last committed row, not first paint, bounds the feedback timestamp', () => {
  const fixture = paintedFixture('canvas2d', 'paint')
  const last = fixture.phase.records.spans.find((span) => span.operation === 'paint')
  fixture.phase.records.spans.push({ ...last, end: (last.start + last.end) / 2 })
  const begin = fixture.events.find((event) => event.name === 'compare/begin')
  const offset = begin.ts / 1000 - begin.args.data.startTime
  const feedback = fixture.events.find((event) => event.name === 'AnimationFrame::Presentation')
  feedback.ts = ((last.start + last.end) / 2 + offset) * 1000
  assert.throws(
    () => presentationLatency(fixture.phase, fixture.events),
    /terminal render boundary end/,
  )
  feedback.ts = (last.end + offset + 1) * 1000
  const result = presentationLatency(fixture.phase, fixture.events)
  assert.equal(
    result.presentations[0].renderBoundaryEnd,
    last.end - (result.captures[0].started - fixture.phase.records.timeOrigin),
  )
})

test('deferred software no-op callback cannot become a paint presentation endpoint', () => {
  for (const [backend, operation] of [
    ['canvas2d', 'paint'],
    ['dom', 'replaceWith'],
    ['xterm-dom', 'replaceChildren'],
  ]) {
    const fixture = paintedFixture(backend, operation)
    const frame = fixture.phase.records.spans.find((span) => span.operation === 'drawFrame')
    const parse = fixture.phase.records.spans.find((span) => span.category === 'parse')
    const noop = { ...frame, start: parse.end, end: (parse.end + frame.start) / 2 }
    fixture.phase.records.spans.unshift(noop)
    const result = presentationLatency(fixture.phase, fixture.events)
    assert.ok(Math.abs(result.write[0] - recorded.expected) < 0.001)
  }
})

test('renderer ownership cannot downgrade WebGPU or xterm WebGL submission safeguards', () => {
  for (const backend of ['webgpu', 'xterm-webgl']) {
    const fixture = paintedFixture(backend, 'paint')
    assert.throws(() => presentationLatency(fixture.phase, fixture.events), /submitted glyph frame/)
  }
  const fixture = paintedFixture('unknown', 'paint')
  assert.throws(() => presentationLatency(fixture.phase, fixture.events), /known terminal renderer/)
})

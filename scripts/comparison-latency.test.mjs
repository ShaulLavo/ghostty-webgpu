import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { presentationLatency, latencyEndpoint } from './comparison-latency.mjs'

const recorded = JSON.parse(
  await readFile(new URL('./fixtures/comparison-presentation.json', import.meta.url)),
)

const linuxRecorded = JSON.parse(
  await readFile(
    new URL('./fixtures/comparison-presentation-linux-headless-shell.json', import.meta.url),
  ),
)

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
    assert.ok(presentation.milliseconds >= presentation.submitEnd)
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
    feedback.ts = (started + offset + selected.submitEnd / 2) * 1000
    assert.ok(feedback.ts / 1000 - offset - started > 0)
    assert.throws(() => presentationLatency(fixture.phase, fixture.events), /GPU submission end/)
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
  assert.equal(result.presentations[0].milliseconds, result.presentations[0].submitEnd)
})

test('recorded xterm WebGL submission selects its own Chrome frame presentation', async () => {
  const fixture = JSON.parse(
    await readFile(new URL('./fixtures/comparison-presentation-xterm.json', import.meta.url)),
  )
  const result = presentationLatency(fixture.phase, fixture.events)
  assert.ok(Math.abs(result.write[0] - fixture.expected) < 0.001)
})

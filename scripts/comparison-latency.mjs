import assert from 'node:assert/strict'
import { mainThread } from './comparison-attribution.mjs'

export const latencyEndpoint = 'AnimationFrame::Presentation (terminal submission frame identity)'

function submissionFrame(records, capture) {
  const started = capture.started - records.timeOrigin
  const captured = capture.timestamp - records.timeOrigin
  const within = (time) => time >= started && time <= captured
  const echo =
    capture.operation === 'input'
      ? records.markers.find(
          (marker) => marker.operation === 'echo-received' && within(marker.time),
        )
      : undefined
  assert(capture.operation !== 'input' || echo, 'Input presentation requires echo receipt')
  const parse = records.spans.find(
    (span) =>
      span.terminal === 0 &&
      span.category === 'parse' &&
      span.start >= (echo?.time ?? started) &&
      span.end <= captured,
  )
  assert(parse, 'Presentation requires the operation parse span')
  const frames = records.spans
    .filter(
      (span) =>
        span.terminal === 0 &&
        ['drawFrame', 'renderRows'].includes(span.operation) &&
        span.start >= parse.end &&
        span.end <= captured,
    )
    .toSorted((a, b) => a.start - b.start)
  for (const frame of frames) {
    const submit = records.spans.find(
      (span) =>
        span.terminal === 0 &&
        span.category === 'commands' &&
        ['submit', 'drawElementsInstanced'].includes(span.operation) &&
        span.start >= frame.start &&
        span.end <= frame.end,
    )
    if (submit) return { started, captured, parse, frame, submit, echo }
  }
  assert.fail('Terminal render requires a submitted glyph frame')
}

export function presentationLatency(phase, events) {
  const { records, sample } = phase
  const clock = mainThread(events, records)
  const feedback = clock.main.filter((event) => event.name === 'AnimationFrame::Presentation')
  const samples = { write: [], input: [], endpoint: latencyEndpoint, captures: sample.captures }
  samples.presentations = sample.captures.map((capture) => {
    const selected = submissionFrame(records, capture)
    const animation = clock.frames.find(
      (frame) => frame.start <= selected.frame.start && frame.end >= selected.frame.end,
    )
    assert(animation?.id !== undefined, 'Terminal submission requires a containing animation frame')
    const presented = feedback.find((event) => event.args?.id === animation.id)
    const presentationTime = presented ? presented.ts / 1000 - clock.offset : null
    const milliseconds = presentationTime === null ? null : presentationTime - selected.started
    assert(
      Number.isFinite(milliseconds) && milliseconds > 0,
      'Terminal frame requires positive Chrome presentation feedback; capture timing is not a fallback',
    )
    assert(
      presentationTime >= selected.submit.end,
      'Terminal presentation feedback must occur at or after its GPU submission end',
    )
    samples[capture.operation].push(milliseconds)
    return {
      operation: capture.operation,
      animationId: animation.id,
      milliseconds,
      captureMilliseconds: selected.captured - selected.started,
      parseEnd: selected.parse.end - selected.started,
      submitEnd: selected.submit.end - selected.started,
    }
  })
  return samples
}

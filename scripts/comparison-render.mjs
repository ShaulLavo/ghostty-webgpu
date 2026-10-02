import assert from 'node:assert/strict'

export const renderOperations = ['drawFrame', 'renderRows', 'render']
const boundaries = {
  webgpu: ['submit'],
  webgl2: ['submit'],
  'xterm-webgl': ['drawElementsInstanced'],
  canvas2d: ['paint'],
  dom: ['replaceWith'],
  'ghostty-web': ['renderLine'],
  'xterm-dom': ['replaceChildren'],
}

export function renderedFrame(records, capture) {
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
  const backend = records.ownership?.find((owner) => owner.terminal === 0)?.backend
  // Older GPU traces predate backend ownership; their submission requirement stays unchanged.
  const operations =
    backend === undefined ? ['submit', 'drawElementsInstanced'] : boundaries[backend]
  assert(operations, 'Presentation requires a known terminal renderer boundary')
  const frames = records.spans
    .filter(
      (span) =>
        span.terminal === 0 &&
        renderOperations.includes(span.operation) &&
        span.start >= parse.end &&
        span.end <= captured,
    )
    .toSorted((a, b) => a.start - b.start)
  for (const frame of frames) {
    const boundary = records.spans
      .filter(
        (span) =>
          span.terminal === 0 &&
          span.category === 'commands' &&
          operations.includes(span.operation) &&
          span.start >= frame.start &&
          span.end <= frame.end,
      )
      .toSorted((a, b) => a.end - b.end)
      .at(-1)
    if (boundary) return { started, captured, parse, frame, boundary, echo, backend }
  }
  assert.fail('Terminal render requires a submitted glyph frame or committed row paint')
}

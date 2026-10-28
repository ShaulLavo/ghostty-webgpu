import assert from 'node:assert/strict'
import { renderedFrame } from '../../scripts/comparison-render.mjs'

export const c5LatencyEndpoint =
  'Chrome AnimationFrame::Presentation joined by terminal command and animation-frame identity'

export function c5PresentationLatency(phase, events) {
  const { records, sample } = phase
  const begin = events.find((event) => event.name === 'compare/begin')
  assert(begin, 'Trace begin marker required')
  const offset = begin.ts / 1000 - begin.args.data.startTime
  const mainTids = events
    .filter(
      (event) =>
        event.pid === begin.pid &&
        event.name === 'thread_name' &&
        event.args?.name === 'CrRendererMain',
    )
    .map((event) => event.tid)
  assert(mainTids.length > 0, 'Renderer main thread required')
  const main = events
    .filter((event) => event.pid === begin.pid && mainTids.includes(event.tid))
    .sort((a, b) => a.ts - b.ts)
  const frames = animationFrames(main, offset)
  const feedback = main.filter((event) => event.name === 'AnimationFrame::Presentation')
  const presentations = sample.captures.map((capture) =>
    joinPresentation(records, capture, frames, feedback, offset),
  )
  return {
    endpoint: c5LatencyEndpoint,
    presentations,
    input: presentations.map((entry) => entry.milliseconds),
    counts: {
      parsed: records.spans.filter((span) => span.terminal === 0 && span.category === 'parse')
        .length,
      submitted: records.counters
        .filter((counter) => counter.operation === 'submissions')
        .reduce((sum, counter) => sum + counter.value, 0),
      presented: presentations.length,
      containing: presentations.filter((entry) => entry.join === 'containing').length,
      previous: presentations.filter((entry) => entry.join === 'previous').length,
      following: presentations.filter((entry) => entry.join === 'following').length,
    },
  }
}

function animationFrames(main, offset) {
  const frames = []
  const pending = new Map()
  for (const event of main) {
    if (event.name !== 'AnimationFrame') continue
    const key = event.id2?.local
    if (event.ph === 'b') pending.set(key, event)
    if (event.ph !== 'e') continue
    const first = pending.get(key)
    if (!first) continue
    frames.push({
      start: first.ts / 1000 - offset,
      end: event.ts / 1000 - offset,
      id: first.args?.id,
    })
    pending.delete(key)
  }
  return frames.sort((a, b) => a.start - b.start)
}

function joinPresentation(records, capture, frames, feedback, offset) {
  const selected = renderedFrame(records, capture)
  const previous = frames.findLast((frame) => frame.start <= selected.boundary.start)
  const previousFeedback = feedback.find((event) => event.args?.id === previous?.id)
  const previousTime = previousFeedback ? previousFeedback.ts / 1000 - offset : null
  let animation =
    previousTime !== null && previousTime >= selected.boundary.end ? previous : undefined
  let join = previous?.end >= selected.boundary.end ? 'containing' : 'previous'
  assert(
    previousFeedback || previous?.end < selected.boundary.start,
    `Animation frame ${previous?.id} requires presentation feedback at submission`,
  )
  if (!animation) {
    animation = frames.find((frame) => frame.start >= selected.boundary.end)
    join = 'following'
  }
  assert(animation, 'Terminal submission requires a preceding or following animation frame')
  const presented = feedback.find((event) => event.args?.id === animation.id)
  assert(presented, `Animation frame ${animation.id} requires presentation feedback`)
  const presentationTime = presented.ts / 1000 - offset
  const started = capture.started - records.timeOrigin
  const milliseconds = presentationTime - started
  assert(Number.isFinite(milliseconds) && milliseconds > 0, 'Positive input presentation required')
  assert(presentationTime >= selected.boundary.end, 'Presentation precedes terminal submission')
  return {
    animationId: animation.id,
    join,
    milliseconds,
    captureMilliseconds: selected.captured - started,
    parseEnd: selected.parse.end - started,
    renderBoundary: selected.boundary.operation,
    renderBoundaryEnd: selected.boundary.end - started,
    screenshotSha256: capture.screenshotSha256,
  }
}

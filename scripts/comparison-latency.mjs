import assert from 'node:assert/strict'
import { mainThread } from './comparison-attribution.mjs'
import { renderedFrame } from './comparison-render.mjs'

export const latencyEndpoint = 'AnimationFrame::Presentation (terminal rendered frame identity)'

export function presentationResult(run, phase, events) {
  try {
    assert(!phase.error, phase.error)
    return { ...presentationLatency(phase, events), trace: phase.trace }
  } catch (error) {
    run.latencyFailure = phase
    throw error
  }
}

export function presentationLatency(phase, events) {
  const { records, sample } = phase
  const clock = mainThread(events, records)
  const feedback = clock.main.filter((event) => event.name === 'AnimationFrame::Presentation')
  const samples = { write: [], input: [], endpoint: latencyEndpoint, captures: sample.captures }
  samples.presentations = sample.captures.map((capture) => {
    const selected = renderedFrame(records, capture)
    const animation = clock.frames.find(
      (frame) => frame.start <= selected.frame.start && frame.end >= selected.frame.end,
    )
    assert(animation?.id !== undefined, 'Terminal render requires a containing animation frame')
    const presented = feedback.find((event) => event.args?.id === animation.id)
    const presentationTime = presented ? presented.ts / 1000 - clock.offset : null
    const milliseconds = presentationTime === null ? null : presentationTime - selected.started
    assert(
      Number.isFinite(milliseconds) && milliseconds > 0,
      'Terminal frame requires positive Chrome presentation feedback; capture timing is not a fallback',
    )
    assert(
      presentationTime >= selected.boundary.end,
      'Terminal presentation feedback must occur at or after its terminal render boundary end',
    )
    samples[capture.operation].push(milliseconds)
    return {
      operation: capture.operation,
      animationId: animation.id,
      milliseconds,
      captureMilliseconds: selected.captured - selected.started,
      parseEnd: selected.parse.end - selected.started,
      renderBoundary: selected.boundary.operation,
      renderBoundaryEnd: selected.boundary.end - selected.started,
    }
  })
  return samples
}

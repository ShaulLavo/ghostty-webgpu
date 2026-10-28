import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { presentationLatency } from '../../scripts/comparison-latency.mjs'
import { renderedFrame } from '../../scripts/comparison-render.mjs'
import { quantile } from '../../scripts/comparison-report.mjs'

const directory = resolve(process.argv[2] ?? '')
assert(directory, 'Pass a C5 output directory')
const report = JSON.parse(await readFile(join(directory, 'c5-results.json'), 'utf8'))
const arms = []
const only = process.env.C5_ANALYSIS_ONLY?.split(',')
for (const arm of report.arms) {
  if (arm.worker || (only && !only.includes(arm.name))) continue
  const events = JSON.parse(
    gunzipSync(await readFile(join(directory, arm.tracePhase.trace))),
  ).traceEvents
  const begin = events.find((event) => event.name === 'compare/begin')
  assert(begin, 'Trace begin marker required')
  const offset = begin.ts / 1000 - begin.args.data.startTime
  const latency = presentationLatency(arm.tracePhase, events)
  const echoes = arm.tracePhase.sample.captures.map((capture, index) =>
    echoTimeline(arm, capture, index, events, offset, latency),
  )
  arms.push({
    name: arm.name,
    backend: arm.info.backend,
    adapter: arm.info.adapter,
    samples: echoes.length,
    summary: summarize(echoes),
    echoes,
  })
}
const output = {
  schema: 1,
  baselineSha: report.baselineSha,
  endpoint:
    'Strict containing AnimationFrame join plus compositor surface_frame_trace_id/display_trace_id and first following display vsync',
  arms,
}
await writeFile(join(directory, 'main-analysis.json'), JSON.stringify(output, null, 2) + '\n')

function echoTimeline(arm, capture, index, events, offset, latency) {
  const selected = renderedFrame(arm.tracePhase.records, capture)
  const submitted = pipelineEvent(
    events,
    selected.boundary.end + offset,
    'STEP_SUBMIT_COMPOSITOR_FRAME',
  )
  const surface = submitted.args.chrome_graphics_pipeline.surface_frame_trace_id
  const swap = events.find(
    (event) =>
      event.ts >= submitted.ts &&
      event.name === 'Graphics.Pipeline' &&
      pipelineStep(event) === 'STEP_FINISH_BUFFER_SWAP' &&
      event.args.chrome_graphics_pipeline.display_trace_id === surface,
  )
  assert(swap, 'Echo compositor frame requires a completed buffer swap')
  const vsync = events.find(
    (event) =>
      event.ts >= swap.ts + (swap.dur ?? 0) &&
      event.pid === swap.pid &&
      event.name === 'OnVSyncPresentation',
  )
  assert(vsync, 'Echo buffer swap requires following display vsync')
  const relative = (event) => event.ts / 1000 - offset - selected.started
  const relativeEnd = (event) => relative(event) + (event.dur ?? 0) / 1000
  const feedback = latency.presentations[index].milliseconds
  return {
    index,
    parseEnd: selected.parse.end - selected.started,
    frameStart: selected.frame.start - selected.started,
    frameEnd: selected.frame.end - selected.started,
    renderBoundaryEnd: selected.boundary.end - selected.started,
    compositorSubmitEnd: relativeEnd(submitted),
    swapEnd: relativeEnd(swap),
    displayVsync: relative(vsync),
    feedback,
    feedbackAfterVsync: feedback - relative(vsync),
  }
}

function pipelineEvent(events, start, step) {
  const event = events.find(
    (candidate) =>
      candidate.ts >= start * 1000 &&
      candidate.name === 'Graphics.Pipeline' &&
      pipelineStep(candidate) === step,
  )
  assert(event, `Echo requires ${step}`)
  return event
}

function pipelineStep(event) {
  return event.args?.chrome_graphics_pipeline?.step
}

function summarize(echoes) {
  const fields = [
    'parseEnd',
    'frameStart',
    'renderBoundaryEnd',
    'compositorSubmitEnd',
    'swapEnd',
    'displayVsync',
    'feedback',
    'feedbackAfterVsync',
  ]
  return Object.fromEntries(
    fields.map((field) => {
      const values = echoes.map((echo) => echo[field])
      return [field, { p50: quantile(values, 0.5), p95: quantile(values, 0.95) }]
    }),
  )
}

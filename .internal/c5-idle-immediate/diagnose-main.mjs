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
  const latency = presentationLatency(arm.tracePhase, events)
  const echoes = arm.tracePhase.sample.captures.map((capture, index) =>
    echoTimeline(arm, capture, index, latency),
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
  schema: 2,
  baselineSha: report.baselineSha,
  endpoint:
    "Strict containing AnimationFrame join; AnimationFrame::Presentation supplies Chrome's reported presentation timestamp, not callback delivery or physical scanout",
  arms,
}
await writeFile(join(directory, 'main-analysis.json'), JSON.stringify(output, null, 2) + '\n')

function echoTimeline(arm, capture, index, latency) {
  const selected = renderedFrame(arm.tracePhase.records, capture)
  const presentationTimestamp = latency.presentations[index].milliseconds
  return {
    index,
    parseEnd: selected.parse.end - selected.started,
    frameStart: selected.frame.start - selected.started,
    frameEnd: selected.frame.end - selected.started,
    renderBoundaryEnd: selected.boundary.end - selected.started,
    presentationTimestamp,
    afterRender: presentationTimestamp - (selected.boundary.end - selected.started),
  }
}

function summarize(echoes) {
  const fields = [
    'parseEnd',
    'frameStart',
    'renderBoundaryEnd',
    'presentationTimestamp',
    'afterRender',
  ]
  return Object.fromEntries(
    fields.map((field) => {
      const values = echoes.map((echo) => echo[field])
      return [field, { p50: quantile(values, 0.5), p95: quantile(values, 0.95) }]
    }),
  )
}

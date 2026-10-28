import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { quantile } from '../../scripts/comparison-report.mjs'

const directory = resolve(process.argv[2] ?? '')
const report = JSON.parse(await readFile(join(directory, 'c5-results.json'), 'utf8'))
assert(!report.error, report.error)
const conditions = [...new Set(report.arms.map((arm) => conditionKey(arm)))]
const rows = conditions.map((condition) => analyzeCondition(condition))
const analysis = {
  schema: 1,
  baselineSha: report.baselineSha,
  candidateSha: report.candidateSha,
  sampleCount: report.sampleCount,
  repetitions: report.repetitions,
  sustainedWrites: report.sustainedWrites,
  endpoint: report.arms[0]?.latency?.endpoint,
  rows,
  keep: rows.every((row) => row.keep),
}
await writeFile(join(directory, 'analysis.json'), JSON.stringify(analysis, null, 2))
console.log(JSON.stringify(analysis, null, 2))

function analyzeCondition(condition) {
  const arms = report.arms.filter((arm) => conditionKey(arm) === condition)
  const baseline = arms.filter((arm) => arm.label === 'baseline')
  const candidate = arms.filter((arm) => arm.label === 'candidate')
  assert.equal(baseline.length, report.repetitions, `${condition} baseline arms`)
  assert.equal(candidate.length, report.repetitions, `${condition} candidate arms`)
  const baselineLatency = baseline.flatMap((arm) => arm.latency.input)
  const candidateLatency = candidate.flatMap((arm) => arm.latency.input)
  const baselineP50 = quantile(baselineLatency, 0.5)
  const baselineP95 = quantile(baselineLatency, 0.95)
  const candidateP50 = quantile(candidateLatency, 0.5)
  const candidateP95 = quantile(candidateLatency, 0.95)
  const pairs = baseline.map((control) => {
    const treatment = candidate.find((arm) => arm.repetition === control.repetition)
    assert(treatment, `${condition} candidate repetition ${control.repetition}`)
    return analyzePair(control, treatment)
  })
  const p50Improvement = 1 - candidateP50 / baselineP50
  const p95Improvement = 1 - candidateP95 / baselineP95
  const medianCpuRatio = quantile(
    pairs.map((pair) => pair.cpuRatio),
    0.5,
  )
  const screenshotsEqual = pairs.every((pair) => pair.screenshotsEqual)
  const workEqual = pairs.every((pair) => pair.workEqual)
  return {
    condition,
    samples: baselineLatency.length,
    baseline: { p50: baselineP50, p95: baselineP95 },
    candidate: { p50: candidateP50, p95: candidateP95 },
    improvement: { p50: p50Improvement, p95: p95Improvement },
    medianCpuRatio,
    screenshotsEqual,
    workEqual,
    counts: {
      baseline: countSummary(baseline),
      candidate: countSummary(candidate),
    },
    pairs,
    keep:
      p50Improvement >= 0.2 &&
      p95Improvement >= 0.2 &&
      medianCpuRatio <= 1 &&
      screenshotsEqual &&
      workEqual,
  }
}

function analyzePair(baseline, candidate) {
  const baselineCpu = baseline.sustained.cpu.percentOfOneCore
  const candidateCpu = candidate.sustained.cpu.percentOfOneCore
  const baselineHashes = baseline.tracePhase.sample.captures.map(
    (capture) => capture.screenshotSha256,
  )
  const candidateHashes = candidate.tracePhase.sample.captures.map(
    (capture) => capture.screenshotSha256,
  )
  const baselineWork = workShape(baseline.sustained.sample)
  const candidateWork = workShape(candidate.sustained.sample)
  const comparableWork = (work) => ({
    writes: work.writes,
    bytes: work.bytes,
    gpuSubmittedFrames: work.gpuSubmittedFrames,
    outputSha256: work.outputSha256,
  })
  return {
    repetition: baseline.repetition,
    baselineP50: quantile(baseline.latency.input, 0.5),
    candidateP50: quantile(candidate.latency.input, 0.5),
    baselineP95: quantile(baseline.latency.input, 0.95),
    candidateP95: quantile(candidate.latency.input, 0.95),
    baselineCpu,
    candidateCpu,
    cpuRatio: candidateCpu / baselineCpu,
    baselineWork,
    candidateWork,
    workEqual:
      JSON.stringify(comparableWork(baselineWork)) ===
      JSON.stringify(comparableWork(candidateWork)),
    screenshotsEqual: JSON.stringify(baselineHashes) === JSON.stringify(candidateHashes),
    screenshotMismatches: baselineHashes.flatMap((hash, index) =>
      hash === candidateHashes[index] ? [] : [index],
    ),
  }
}

function workShape(sample) {
  return {
    writes: sample.writes,
    bytes: sample.bytes,
    hostFrameNotices: sample.submittedFrames,
    gpuSubmittedFrames: sample.metrics.submittedFrames,
    outputSha256: createHash('sha256').update(sample.output).digest('hex'),
  }
}

function countSummary(arms) {
  return Object.fromEntries(
    ['parsed', 'submitted', 'presented', 'containing', 'previous', 'following'].map((key) => [
      key,
      arms.reduce((sum, arm) => sum + arm.latency.counts[key], 0),
    ]),
  )
}

function conditionKey(arm) {
  return `${arm.backend}-${arm.worker ? 'worker' : 'main'}`
}

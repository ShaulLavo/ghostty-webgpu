import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = new URL('./', import.meta.url)
const scores = JSON.parse(await readFile(new URL('scores.json', root)))
const metrics = ['energyJ', 'instructions', 'cpuSeconds']
const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2) return sorted[middle]
  return (sorted[middle - 1] + sorted[middle]) / 2
}

// Pair the n-th run of the ghostty actor with the n-th run of its counterpart.
// A session can interleave windows of other actors, so adjacency is not required.
export function ratios(result) {
  assert.equal(result.complete, true)
  const [own, counterpart] = result.protocol.comparisons[0]
  const ownRuns = result.runs.filter((run) => run.actor === own)
  const counterpartRuns = result.runs.filter((run) => run.actor === counterpart)
  assert.equal(ownRuns.length, counterpartRuns.length)
  assert.equal(ownRuns.length, 2)
  const pairs = ownRuns.map((numerator, at) => {
    const denominator = counterpartRuns[at]
    assert.equal(numerator.contentSha256, denominator.contentSha256)
    return Object.fromEntries(
      metrics.map((metric) => {
        const value =
          numerator.native.channels.allChrome[metric] /
          denominator.native.channels.allChrome[metric]
        assert(Number.isFinite(value) && value > 0)
        return [metric, value]
      }),
    )
  })
  return Object.fromEntries(
    metrics.map((metric) => [
      metric,
      {
        pairs: pairs.map((pair) => pair[metric]),
        median: median(pairs.map((pair) => pair[metric])),
      },
    ]),
  )
}

function checkRun(run, result) {
  const { count, ticks } = result.protocol
  assert.equal(run.status, 'complete')
  assert.deepEqual(run.errors, [])
  assert.equal(run.hostAfter.ac, true)
  assert.equal(run.content.length, count)
  assert.equal(run.targetWork.length, count)
  const all = run.native.channels.allChrome
  const perPid = run.native.perPid
  assert.equal(
    perPid.reduce((sum, pid) => sum + pid.ri_instructions, 0),
    all.instructions,
  )
  assert(
    Math.abs(perPid.reduce((sum, pid) => sum + pid.ri_energy_nj, 0) / 1e9 - all.energyJ) < 1e-7,
  )
  const seconds = perPid.reduce((sum, pid) => sum + pid.ri_user_time + pid.ri_system_time, 0) / 1e9
  assert(Math.abs(seconds - all.cpuSeconds) < 1e-7)
  for (const target of run.targetWork) assert.equal(target.counters.publicWrites, ticks + 1)
}

const close = (actual, expected, tolerance) => Math.abs(actual - expected) < tolerance
const reviews = new Map()
const readReview = async (name) => {
  if (!reviews.has(name)) reviews.set(name, JSON.parse(await readFile(new URL(name, root))))
  return reviews.get(name)
}

for (const score of scores.scores) {
  assert(score.status.startsWith('reviewed:'), 'Only reviewed rows go public')
  const result = JSON.parse(await readFile(new URL(score.source, root)))
  const review = await readReview(score.review)
  const cell = review.cells.find((entry) => entry.id === score.reviewCell)
  assert(cell, `${score.reviewCell}: review cell missing`)
  assert.equal(cell.verdict, 'PUBLISHABLE WITH LIMITS')
  assert.equal(cell.qualifiedForNumericalPublication, true)
  assert.equal(cell.rawSha256, result.originalIndexSha256)
  assert.equal(cell.sourceBuild, scores.conditions.runtimeCommit)
  assert.equal(cell.versions['ghostty-webgpu'], scores.conditions.versions['ghostty-webgpu'])
  assert.equal(result.bundleSha256, score.bundleSha256)
  assert.equal(result.runtimeCommit, scores.conditions.runtimeCommit)
  const inputBytes = new Set()
  for (const run of result.runs) {
    checkRun(run, result)
    for (const target of run.targetWork) inputBytes.add(target.counters.inputBytes)
  }
  assert.equal(inputBytes.size, 1, `${score.source}: input bytes differ between targets`)
  const actual = ratios(result)
  const reviewed = cell.allChrome.scoredMetrics
  for (const [publicKey, rawKey, pairsKey] of [
    ['energy', 'energyJ', 'energyPairs'],
    ['instructions', 'instructions', 'instructionPairs'],
    ['cpuSeconds', 'cpuSeconds'],
  ]) {
    assert(
      close(actual[rawKey].median, score[publicKey], 0.00006),
      `${score.source}: ${publicKey} ${actual[rawKey].median} != ${score[publicKey]}`,
    )
    if (!pairsKey) continue
    assert(
      close(actual[rawKey].median, reviewed[rawKey].median, 1e-9),
      `${score.source}: review median`,
    )
    actual[rawKey].pairs.forEach((pair, at) =>
      assert(close(pair, score[pairsKey][at], 0.00006), `${score.source}: ${publicKey} pair ${at}`),
    )
  }
}
for (const gap of scores.unavailable) {
  const review = await readReview(gap.review)
  const cell = review.cells.find((entry) => entry.id === gap.reviewCell)
  assert.equal(cell?.verdict, 'NOT PUBLISHABLE')
}
console.log(
  `PASS: ${scores.scores.length} reviewed rows reproduce from per-process counters; ${scores.unavailable.length} unavailable row recorded`,
)

if (process.argv[2]) {
  const result = JSON.parse(
    await readFile(fileURLToPath(new URL(process.argv[2], `file://${process.cwd()}/`))),
  )
  console.log(JSON.stringify(ratios(result), null, 2))
}

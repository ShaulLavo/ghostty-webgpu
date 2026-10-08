import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = new URL('./', import.meta.url)
const scores = JSON.parse(await readFile(new URL('scores.json', root)))
const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2) return sorted[middle]
  return (sorted[middle - 1] + sorted[middle]) / 2
}

export function ratios(result) {
  assert.equal(result.complete, true)
  assert.deepEqual(
    result.runs.map((run) => run.actor),
    result.protocol.order,
  )
  assert.equal(result.runs.length % 2, 0)
  const pairs = []
  for (let index = 0; index < result.runs.length; index += 2) {
    const adjacent = result.runs.slice(index, index + 2)
    const numerator = adjacent.find((run) => !run.actor.startsWith('X'))
    const denominator = adjacent.find((run) => run.actor.startsWith('X'))
    assert(numerator && denominator, 'Each pair needs both libraries')
    assert.equal(numerator.contentSha256, denominator.contentSha256)
    pairs.push(
      Object.fromEntries(
        ['energyJ', 'instructions', 'cpuSeconds'].map((metric) => {
          const value =
            numerator.native.channels.allChrome[metric] /
            denominator.native.channels.allChrome[metric]
          assert(Number.isFinite(value) && value > 0)
          return [metric, value]
        }),
      ),
    )
  }
  return Object.fromEntries(
    ['energyJ', 'instructions', 'cpuSeconds'].map((metric) => [
      metric,
      median(pairs.map((pair) => pair[metric])),
    ]),
  )
}

for (const score of scores.scores) {
  assert(score.status.startsWith('reviewed:'), 'Only reviewed rows go public')
  const result = JSON.parse(await readFile(new URL(score.source, root)))
  const review = JSON.parse(await readFile(new URL(score.review, root)))
  assert(
    review.complete === true || review.verdict || review.verdicts,
    'Independent review required',
  )
  assert.equal(result.bundleSha256, score.bundleSha256)
  assert.equal(result.runtimeCommit, scores.conditions.runtimeCommit)
  for (const run of result.runs) {
    assert.equal(run.status, 'complete')
    assert.deepEqual(run.errors, [])
    assert.equal(run.hostAfter.ac, true)
    assert.equal(run.content.length, result.protocol.count)
    assert.equal(run.targetWork.length, result.protocol.count)
    const perPid = run.native.perPid
    const all = run.native.channels.allChrome
    assert.equal(
      perPid.reduce((sum, pid) => sum + pid.ri_instructions, 0),
      all.instructions,
    )
    assert(
      Math.abs(perPid.reduce((sum, pid) => sum + pid.ri_energy_nj, 0) / 1e9 - all.energyJ) < 1e-7,
    )
    assert(
      Math.abs(
        perPid.reduce((sum, pid) => sum + pid.ri_user_time + pid.ri_system_time, 0) / 1e9 -
          all.cpuSeconds,
      ) < 1e-7,
    )
    for (const target of run.targetWork) {
      assert.equal(target.counters.publicWrites, result.protocol.ticks + 1)
      if (result.protocol.expectedInputBytesPerTarget)
        assert.equal(target.counters.inputBytes, result.protocol.expectedInputBytesPerTarget)
    }
  }
  const actual = ratios(result)
  for (const [publicKey, rawKey] of [
    ['energy', 'energyJ'],
    ['instructions', 'instructions'],
    ['cpuSeconds', 'cpuSeconds'],
  ]) {
    assert(
      Math.abs(actual[rawKey] - score[publicKey]) < 0.00006,
      `${score.source}: ${publicKey} ${actual[rawKey]} != ${score[publicKey]}`,
    )
  }
}
const assets = JSON.parse(await readFile(new URL('reproduce/assets.json', root)))
for (const [name, digest] of Object.entries(assets.archives)) {
  const bytes = await readFile(new URL(`reproduce/assets/${name}`, root))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), digest)
}
console.log(
  `PASS: ${scores.scores.length} reviewed rows reproduce from per-process counters; ${Object.keys(assets.archives).length} frozen archives verified`,
)

if (process.argv[2]) {
  const result = JSON.parse(
    await readFile(fileURLToPath(new URL(process.argv[2], `file://${process.cwd()}/`))),
  )
  console.log(JSON.stringify(ratios(result), null, 2))
}

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.argv[2]
const receipts = root
  ? undefined
  : JSON.parse(await readFile(new URL('./results.json', import.meta.url), 'utf8'))
const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]
const rows = []
let keep = true
for (const host of ['pc', 'mac']) {
  for (const dpr of [1, 2]) await analyze(host, dpr)
}
console.log(
  '| Host | DPR | Backend | Workload | Raster before ms/update | Raster batch ms/update | Reduction | Equal screen/atlas pairs |',
)
console.log('| --- | --- | --- | --- | --- | --- | --- | --- |')
for (const row of rows) console.log('| ' + row.join(' | ') + ' |')
console.log('\n' + (keep ? 'KEEP' : 'REJECT') + ' at the 40% raster-time gate.')

async function analyze(host, dpr) {
  const artifact = root
    ? JSON.parse(await readFile(join(root, host, 'dpr' + dpr + '.json'), 'utf8'))
    : receipts.artifacts.find((entry) => entry.host === host && entry.dpr === dpr)
  assert(artifact, 'complete host and DPR matrix')
  assert(artifact.protocol.performanceQualified, host + ' DPR ' + dpr + ' runner qualification')
  for (const backend of ['webgl2', 'webgpu']) {
    for (const scenario of ['glyph-churn', 'cold-cache'])
      analyzeCase(artifact, host, dpr, backend, scenario)
  }
}

function analyzeCase(artifact, host, dpr, backend, scenario) {
  const beforeTimes = []
  const batchTimes = []
  const ratios = []
  let equalPairs = 0
  for (let repetition = 0; repetition < 3; repetition += 1) {
    const pair = artifact.results.filter(
      (run) =>
        run.backend === backend && run.scenario === scenario && run.repetition === repetition,
    )
    const before = pair.find((run) => run.source === 'before')
    const batch = pair.find((run) => run.source === 'candidate')
    assert(before && batch, 'complete pair')
    assert.equal(before.writtenBytes, batch.writtenBytes, 'equal input bytes')
    assert.equal(before.outputSha256, batch.outputSha256, 'equal retained text')
    for (const key of ['parsedWrites', 'submittedFrames', 'acknowledgements', 'observerFrames']) {
      assert(Number.isInteger(before.metrics[key]), 'recorded ' + key)
      assert.equal(before.metrics[key], batch.metrics[key], 'equal ' + key)
    }
    const sameScreen = before.screenSha256 === batch.screenSha256
    const sameAtlas =
      JSON.stringify(before.info?.atlas ?? before.atlas) ===
      JSON.stringify(batch.info?.atlas ?? batch.atlas)
    if (sameScreen && sameAtlas) equalPairs += 1
    ratios.push(batch.metrics.rasterMilliseconds / before.metrics.rasterMilliseconds)
    beforeTimes.push(before.metrics.rasterMilliseconds / before.steps)
    batchTimes.push(batch.metrics.rasterMilliseconds / batch.steps)
  }
  const reduction = 100 * (1 - median(ratios))
  keep &&= reduction >= 40 && equalPairs === 3
  rows.push([
    host,
    dpr,
    backend,
    scenario,
    median(beforeTimes).toFixed(3),
    median(batchTimes).toFixed(3),
    reduction.toFixed(1) + '%',
    equalPairs + '/3',
  ])
}

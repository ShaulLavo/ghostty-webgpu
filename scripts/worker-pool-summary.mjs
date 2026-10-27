import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'

const input = process.argv[2]
assert(input, 'usage: node scripts/worker-pool-summary.mjs hardware.json [summary.json]')
const receipt = JSON.parse(await readFile(input, 'utf8'))
const equals = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length
const heapBytes = (row) =>
  row.workerHeaps.reduce(
    (sum, value) => sum + value.usedSize + value.embedderHeapUsedSize + value.backingStorageSize,
    0,
  )
const cases = new Map()
for (const row of receipt.results) {
  const key = `${row.fixture}/${row.count}/${row.columns}x${row.rows}`
  const entry = cases.get(key) ?? { control: [], pool: [] }
  entry[row.mode].push(row)
  cases.set(key, entry)
}
function compare(key, group) {
  const { control, pool } = group
  assert(control.length === pool.length && control.length > 0, `unpaired ${key}`)
  const ratio = (read) => mean(pool.map(read)) / mean(control.map(read))
  const pairs = control.map((before) => {
    const after = pool.find((value) => value.repetition === before.repetition)
    assert(after, `missing paired repetition ${key}`)
    return {
      repetition: before.repetition,
      sameBrowserSession: before.browserSession === after.browserSession,
      textEqual: equals(before.rowHashes, after.rowHashes),
      pixelsEqual: equals(before.screenshots, after.screenshots),
      updatesEqual: equals(before.deliveredFrames, after.deliveredFrames),
      controlDeliveredAll: equals(before.deliveredFrames, before.writeCounts),
      poolDeliveredAll: equals(after.deliveredFrames, after.writeCounts),
      controlFrames: before.deliveredFrames,
      poolFrames: after.deliveredFrames,
      lifecycle: after.lifecycle,
    }
  })
  return {
    case: key,
    repetitions: control.length,
    hostTaskMillisecondsPerFrame: {
      control: mean(control.map((row) => row.hostTaskMillisecondsPerFrame)),
      pool: mean(pool.map((row) => row.hostTaskMillisecondsPerFrame)),
      ratio: ratio((row) => row.hostTaskMillisecondsPerFrame),
    },
    handlerMillisecondsPerFrame: {
      control: mean(
        control.map(
          (row) =>
            row.hostHandlerMilliseconds /
            row.deliveredFrames.reduce((sum, value) => sum + value, 0),
        ),
      ),
      pool: mean(
        pool.map(
          (row) =>
            row.hostHandlerMilliseconds /
            row.deliveredFrames.reduce((sum, value) => sum + value, 0),
        ),
      ),
    },
    totalResidentMiB: {
      control: mean(control.map((row) => row.memory.hostPlusGpuMiB)),
      pool: mean(pool.map((row) => row.memory.hostPlusGpuMiB)),
      ratio: ratio((row) => row.memory.hostPlusGpuMiB),
    },
    pssMiB: {
      control: mean(control.map((row) => row.memory.pssKiB / 1024)),
      pool: mean(pool.map((row) => row.memory.pssKiB / 1024)),
      ratio: ratio((row) => row.memory.pssKiB),
    },
    workerHeapMiB: {
      control: mean(control.map(heapBytes)) / 1024 ** 2,
      pool: mean(pool.map(heapBytes)) / 1024 ** 2,
    },
    workerCpuSeconds: {
      control: mean(control.map((row) => row.cpu.workerSeconds)),
      pool: mean(pool.map((row) => row.cpu.workerSeconds)),
      ratio: ratio((row) => row.cpu.workerSeconds),
    },
    ackP50: {
      control: mean(control.map((row) => row.acknowledgement.p50)),
      pool: mean(pool.map((row) => row.acknowledgement.p50)),
    },
    ackP95: {
      control: mean(control.map((row) => row.acknowledgement.p95)),
      pool: mean(pool.map((row) => row.acknowledgement.p95)),
      ratio: ratio((row) => row.acknowledgement.p95),
    },
    ackP99: {
      control: mean(control.map((row) => row.acknowledgement.p99)),
      pool: mean(pool.map((row) => row.acknowledgement.p99)),
      ratio: ratio((row) => row.acknowledgement.p99),
    },
    pairs,
  }
}
const casesCompared = Array.from(cases, ([key, group]) => compare(key, group))
const correctness = casesCompared.every((row) =>
  row.pairs.every(
    (pair) =>
      pair.sameBrowserSession &&
      pair.textEqual &&
      pair.pixelsEqual &&
      pair.updatesEqual &&
      pair.controlDeliveredAll &&
      pair.poolDeliveredAll,
  ),
)
const gates = {
  complete: receipt.repetitions >= 2 && casesCompared.length === 12,
  correctness,
  hostPublication: casesCompared.every((row) => row.hostTaskMillisecondsPerFrame.ratio <= 0.5),
  memory16: casesCompared
    .filter((row) => row.case.split('/')[1] === '16')
    .every((row) => row.totalResidentMiB.ratio <= 0.7),
  ackLatency: casesCompared.every((row) => row.ackP95.ratio <= 1.2 && row.ackP99.ratio <= 1.2),
}
const summary = {
  source: receipt.source,
  headless: receipt.headless,
  steps: receipt.steps,
  repetitions: receipt.repetitions,
  qualifiedHardware: receipt.headless === false,
  gates,
  decision: receipt.headless === false && Object.values(gates).every(Boolean) ? 'KEEP' : 'REJECT',
  cases: casesCompared,
}
const result = JSON.stringify(summary, null, 2) + '\n'
if (process.argv[3]) await writeFile(process.argv[3], result)
else process.stdout.write(result)

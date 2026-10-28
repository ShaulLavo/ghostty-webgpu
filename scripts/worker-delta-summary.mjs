import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
const packet = JSON.parse(await readFile(process.argv[2], 'utf8'))
const groups = new Map()
for (const run of packet.results) {
  const key = `${run.fixture}/${run.count}/${run.columns}x${run.rows}`
  const group = groups.get(key) ?? { control: [], delta: [] }
  group[run.mode].push(run)
  groups.set(key, group)
}
const mean = (runs, read) => runs.reduce((sum, run) => sum + read(run), 0) / runs.length
function quantiles(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? null
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99) }
}
function timingSummary(runs) {
  const busy = runs.flatMap((run) => {
    const terminals = new Map()
    for (const t of run.timings)
      if (t.kind === 'reply') terminals.set(t.terminal, (terminals.get(t.terminal) ?? 0) + 1)
    const terminal = Array.from(terminals).sort((a, b) => b[1] - a[1])[0]?.[0]
    return run.timings.filter((t) => t.terminal === terminal)
  })
  const replies = busy.filter((t) => t.kind === 'reply')
  const frames = busy.filter((t) => t.kind === 'frame')
  return {
    queueMs: quantiles(replies.map((t) => t.execute - t.queue)),
    parseReplyMs: quantiles(replies.map((t) => t.at - t.execute)),
    encodeMs: quantiles(frames.map((t) => t.end - t.at)),
    postToHostMs: quantiles(frames.map((t) => t.received - t.end)),
    hostFrameMs: quantiles(frames.map((t) => t.completed - t.received)),
    gcEvents: runs.reduce((sum, run) => sum + run.gc.events.length, 0),
  }
}
const conditions = Array.from(groups, ([condition, arms]) => {
  assert(arms.control.length === packet.repetitions && arms.delta.length === packet.repetitions)
  const ratio = (read) => mean(arms.delta, read) / mean(arms.control, read)
  const ratios = {
    host: ratio((r) => r.hostTaskMillisecondsPerFrame),
    worker: ratio((r) => r.cpu.workerSeconds),
    memory: ratio((r) => r.memory.totalResidentMiB),
    p95: ratio((r) => r.acknowledgement.p95),
    p99: ratio((r) => r.acknowledgement.p99),
  }
  const gates = {
    host: ratios.host <= 0.5,
    worker: ratios.worker <= 1,
    memory: ratios.memory <= 1,
    p95: ratios.p95 <= 1.2,
    p99: ratios.p99 <= 1.2,
  }
  for (let repetition = 0; repetition < packet.repetitions; repetition += 1) {
    const a = arms.control.find((r) => r.repetition === repetition)
    const b = arms.delta.find((r) => r.repetition === repetition)
    for (const key of [
      'inputHashes',
      'inputBytes',
      'eventHashes',
      'rowHashes',
      'snapshotHashes',
      'screenshots',
      'deliveredFrames',
      'parsedCounts',
      'submittedCounts',
    ])
      assert.deepEqual(a[key], b[key], `${condition} ${key}`)
    for (const run of [a, b]) {
      assert.deepEqual(run.parsedCounts, run.deliveredFrames)
      assert.deepEqual(run.submittedCounts, run.deliveredFrames)
      assert.equal(run.errors.length + run.pageErrors.length, 0)
      assert.equal(run.workerHeaps.length, run.count)
      assert(
        run.timings.some(
          (entry) =>
            entry.kind === 'frame' &&
            Number.isFinite(entry.queue) &&
            Number.isFinite(entry.execute),
        ),
      )
    }
  }
  return {
    condition,
    ratios,
    gates,
    arms: Object.fromEntries(
      Object.entries(arms).map(([name, runs]) => [
        name,
        {
          timing: timingSummary(runs),
          hostMs: mean(runs, (r) => r.hostTaskMillisecondsPerFrame),
          hostReceiverMsPerFrame: mean(
            runs,
            (r) =>
              r.hostHandlerMilliseconds / r.deliveredFrames.reduce((sum, count) => sum + count, 0),
          ),
          workerSeconds: mean(runs, (r) => r.cpu.workerSeconds),
          memoryMiB: mean(runs, (r) => r.memory.totalResidentMiB),
          p95: mean(runs, (r) => r.acknowledgement.p95),
          p99: mean(runs, (r) => r.acknowledgement.p99),
        },
      ]),
    ),
  }
})
const summary = {
  countEndpoints: {
    parsed: 'Acknowledged native writes',
    delivered: 'Host frame callbacks',
    submitted: 'Renderer metrics read independently through worker CDP targets',
    presented: 'Unresolved',
  },
  decision: conditions.every((c) => Object.values(c.gates).every(Boolean))
    ? 'KEEP candidate, public API qualification still required'
    : 'REJECT',
  conditions,
}
await writeFile(process.argv[3], JSON.stringify(summary, null, 2) + '\n')
console.log(summary.decision)
for (const c of conditions) console.log(c.condition, c.ratios, c.gates)

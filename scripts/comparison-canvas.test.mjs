import assert from 'node:assert/strict'
import { test } from 'node:test'
import { measurementCases, selectedVariants } from './comparison-options.mjs'
import { pairedRatios } from './comparison-report.mjs'
import { compactEvidence } from './comparison-compact.mjs'

function canvasArtifact() {
  const variants = ['ghostty-canvas', 'ghostty-web', 'xterm-dom']
  const seconds = { 'ghostty-canvas': 2, 'ghostty-web': 4, 'xterm-dom': 3 }
  return {
    variants,
    paths: ['bytes'],
    counts: [1, 17],
    repetitions: 4,
    phases: ['output', 'latency'],
    manifest: { settings: { minimumCpuTicks: 100 } },
    runs: [1, 17].flatMap((count) =>
      [0, 1, 2, 3].flatMap((repetition) =>
        variants.map((variant) => ({
          variant,
          path: 'bytes',
          count,
          repetition,
          sessionId: 'canvas-session',
          pairId: `canvas-session/${repetition}`,
          output: {
            cpu: {
              milliseconds: 10_000,
              tickSeconds: 0.01,
              secondsByType: { renderer: seconds[variant] },
              percentOfOneCore: seconds[variant] * 10,
            },
          },
          latency: {
            input: Array(96).fill(seconds[variant]),
            write: Array(96).fill(seconds[variant]),
          },
        })),
      ),
    ),
  }
}

test('Canvas pairs with its primary and explicitly selected secondary counterpart', () => {
  const artifact = canvasArtifact()
  const rows = pairedRatios(artifact).filter(
    ({ metric }) => metric !== 'idle/cpu/renderer' && metric !== 'idle/cpu/total',
  )
  assert.equal(rows.length, 20)
  for (const count of artifact.counts) {
    for (const variant of ['ghostty-web', 'xterm-dom']) {
      const row = rows.find(
        (row) =>
          row.count === count && row.variant === variant && row.metric === 'output/cpu/renderer',
      )
      assert(row, `Missing Canvas counterpart ${variant} at ${count} terminals`)
      assert.equal(row.nativeVariant, 'ghostty-canvas')
      assert.equal(row.status, 'pass')
      assert.equal(row.repetitions, 4)
      assert(Math.abs(row.median - 2 / (variant === 'ghostty-web' ? 4 : 3)) < Number.EPSILON)
      assert.deepEqual(
        row.pairs.map(({ ticks }) => ticks),
        Array(4).fill([200, variant === 'ghostty-web' ? 400 : 300]),
      )
      assert.deepEqual(
        row.pairs.map(({ sessionId }) => sessionId),
        Array(4).fill('canvas-session'),
      )
      assert.equal(
        rows.find(
          (row) => row.count === count && row.variant === variant && row.metric === 'input/p95',
        ).pairs.length,
        4,
      )
    }
  }
})

test('Canvas secondary pairing preserves qualification and partner identity guards', () => {
  for (const change of [
    (run) => {
      run.sessionId = 'another-session'
    },
    (run) => {
      run.gpuIdle = { qualified: false }
    },
    (run) => {
      run.error = 'rejected window'
    },
    (run, artifact) => {
      artifact.runs.push({ ...run })
    },
  ]) {
    const artifact = canvasArtifact()
    const run = artifact.runs.find((run) => run.variant === 'xterm-dom' && run.count === 17)
    change(run, artifact)
    const rows = pairedRatios(artifact).filter(
      (row) => row.count === 17 && row.metric === 'output/cpu/renderer',
    )
    assert.equal(rows.find(({ variant }) => variant === 'ghostty-web').status, 'pass')
    const secondary = rows.find(({ variant }) => variant === 'xterm-dom')
    assert(secondary, 'Missing secondary comparison')
    assert.equal(secondary.status, 'incomplete')
    assert.equal(secondary.repetitions, 3)
  }
})

test('Canvas CPU quantization is assessed separately for each counterpart', () => {
  for (const seconds of [0.5, 2.01]) {
    const artifact = canvasArtifact()
    for (const run of artifact.runs) {
      if (run.variant !== 'xterm-dom') continue
      run.output.cpu.secondsByType.renderer = seconds
      run.output.cpu.percentOfOneCore = seconds * 10
    }
    const rows = pairedRatios(artifact).filter(({ metric }) => metric === 'output/cpu/renderer')
    assert(
      rows
        .filter(({ variant }) => variant === 'ghostty-web')
        .every(({ status }) => status === 'pass'),
    )
    assert(
      rows
        .filter(({ variant }) => variant === 'xterm-dom')
        .every(({ status, repetitions }) => status === 'unresolved' && repetitions === 4),
    )
  }
})

test('compact Canvas evidence shares each raw run across both comparison edges', async () => {
  const artifact = canvasArtifact()
  artifact.environment = { gpu: { gpu: { devices: [], featureStatus: {} } } }
  const original = structuredClone(artifact)
  const compact = await compactEvidence(artifact)
  assert.deepEqual(artifact, original)
  assert.equal(compact.runs.length, 24)
  assert.equal(compact.pairedRatios.length, 28)
  assert.deepEqual(compact.pairedRatios, pairedRatios(artifact))
  assert.deepEqual(
    compact.runs.map(({ sessionId, pairId, variant, count, repetition }) => ({
      sessionId,
      pairId,
      variant,
      count,
      repetition,
    })),
    artifact.runs.map(({ sessionId, pairId, variant, count, repetition }) => ({
      sessionId,
      pairId,
      variant,
      count,
      repetition,
    })),
  )
  assert.equal(compact.runs.filter(({ variant }) => variant === 'ghostty-canvas').length, 8)
  assert.equal(
    compact.runs.reduce((sum, run) => sum + run.output.cpu.secondsByType.renderer, 0),
    72,
  )
})

test('Canvas primary remains automatic and the DOM secondary is opt-in', () => {
  const available = ['ghostty-canvas', 'ghostty-web', 'xterm-dom']
  assert.deepEqual(selectedVariants(['--variants', 'ghostty-canvas'], available, []), [
    'ghostty-canvas',
    'ghostty-web',
  ])
  assert.deepEqual(selectedVariants(['--variants', 'ghostty-canvas,xterm-dom'], available, []), [
    'ghostty-canvas',
    'xterm-dom',
    'ghostty-web',
  ])
  const artifact = canvasArtifact()
  artifact.variants = ['ghostty-canvas', 'ghostty-web']
  artifact.runs = artifact.runs.filter(({ variant }) => variant !== 'xterm-dom')
  assert.equal(pairedRatios(artifact).length, 14)
  assert(pairedRatios(artifact).every(({ variant }) => variant === 'ghostty-web'))
})

test('three-way Canvas treatments balance before and after both counterparts', () => {
  const balance = { 'ghostty-web': 0, 'xterm-dom': 0 }
  for (let repetition = 0; repetition < 4; repetition++) {
    const variants = measurementCases(
      ['ghostty-canvas', 'ghostty-web', 'xterm-dom'],
      ['bytes'],
      [17],
      repetition,
    ).map(({ variant }) => variant)
    for (const counterpart of Object.keys(balance)) {
      balance[counterpart] +=
        variants.indexOf('ghostty-canvas') < variants.indexOf(counterpart) ? 1 : -1
    }
  }
  assert.deepEqual(balance, { 'ghostty-web': 0, 'xterm-dom': 0 })
})

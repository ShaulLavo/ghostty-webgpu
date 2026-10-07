import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { measurementCases } from './comparison-options.mjs'

const source = await readFile(new URL('./comparison-runner.mjs', import.meta.url), 'utf8')
const start = source.indexOf('async function measureBody(')
const end = source.indexOf('\ntry {', start)
assert(start >= 0 && end > start, 'Runner measurement boundary must exist')
// Execute the real failure handler without the runner's top-level browser and hardware setup.
const createMeasureBody = new Function(
  'browser',
  'tracing',
  'phases',
  's',
  'output',
  'join',
  'writeFile',
  'origin',
  'smoke',
  'args',
  'accessibility',
  'platform',
  `return ${source.slice(start, end)}`,
)

async function failureArtifacts(testCase, repetition, evidence) {
  const screenshots = []
  const captures = []
  const error = new Error('Injected page navigation failure')
  error.captureData = Buffer.from('captured PNG').toString('base64')
  error.captureMetadata = { timestamp: 1 }
  if (evidence) Object.assign(error, evidence)
  const page = {
    on() {},
    goto: async (url) => {
      const query = new URL(url).searchParams
      assert.equal(query.get('accessibility'), 'on')
      assert.equal(query.has('zig'), false)
      throw error
    },
    evaluate: async () => ({}),
    screenshot: async ({ path }) => screenshots.push(basename(path)),
  }
  const context = { newPage: async () => page, close: async () => {} }
  const measureBody = createMeasureBody(
    { newContext: async () => context },
    false,
    [],
    { viewport: { width: 1, height: 1 }, dpr: 1 },
    join(tmpdir(), 'comparison-runner-test'),
    join,
    async (path, bytes) => {
      captures.push(basename(path))
      assert.equal(bytes.toString(), 'captured PNG')
    },
    'http://localhost',
    true,
    [],
    'on',
    () => 'linux',
  )
  const contexts = new Set()
  const run = {}
  await measureBody(testCase, repetition, undefined, run, contexts)
  assert.match(run.error, /Injected page navigation failure/)
  assert.equal(contexts.size, 0)
  return { screenshots, captures, ...(evidence ? { run } : {}) }
}

for (const [kind, prefix] of [
  ['screenshots', 'failure'],
  ['captures', 'capture-failure'],
]) {
  test(`${prefix} artifacts distinguish GPU backends`, async () => {
    const names = []
    const treatments = ['ghostty-webgpu', 'ghostty-webgl'].map((variant) => ({
      variant,
      frameBuilder: 'zig',
    }))
    for (const { variant, frameBuilder } of treatments) {
      const artifacts = await failureArtifacts(
        { variant, frameBuilder, path: 'bytes', count: 8 },
        2,
      )
      assert.deepEqual(artifacts[kind], [`${prefix}-${variant}-${frameBuilder}-bytes-8-2.png`])
      names.push(...artifacts[kind])
    }
    assert.equal(new Set(names).size, 2)
  })
}

for (const name of ['rolling-logs', 'rolling-slow'])
  test(`${name} reaches warmup, measured writes, and the artifact`, async () => {
    const fixture = { name, sha256: 'corpus', stream: { sha256: 'framed-cycle' } }
    const artifactStart = source.indexOf('const artifact = {')
    const artifactEnd = source.indexOf('\nconst artifactPath', artifactStart)
    const artifact = new Function(
      'context',
      `
    const {randomUUID, manifest, smoke, tracing, repetitions, latencySamples, outputFrames,
      selectedOutputFixture, tickSeconds, cpuTickSource, counts, variantIds, phases, writePaths,
      fixtures, s, tracePhases, traceFrames, accessibility, measurementCases,
      gpuCommandTimeoutMilliseconds, cpuOptions} = context;
    ${source.slice(artifactStart, artifactEnd)}
    return artifact;
  `,
    )({
      randomUUID: () => 'session',
      manifest: { fixtures: [fixture] },
      smoke: false,
      tracing: false,
      gpuCommandTimeoutMilliseconds: 2000,
      cpuOptions: { processCounters: true },
      repetitions: 4,
      outputFrames: 1200,
      selectedOutputFixture: fixture.name,
      counts: [17],
      variantIds: ['ghostty-webgl', 'xterm-webgl'],
      phases: ['output'],
      accessibility: 'on',
      measurementCases,
      writePaths: ['bytes'],
      fixtures: [fixture.name],
      s: { caseDeadlineMilliseconds: 600000 },
    })
    assert.equal(artifact.outputFixture, fixture.name)
    assert.equal(artifact.outputFrames, 1200)
    assert.equal(artifact.accessibility, 'on')
    assert.equal(artifact.processCounters, true)
    assert.equal(artifact.measurementBudgetMilliseconds, 2 * 4 * 600000)
    const blockStart = source.indexOf("    if (phases.includes('output')) {")
    const blockEnd = source.indexOf('\n    assert.deepEqual(errors, [])', blockStart)
    const calls = []
    const window = {
      __compare: {
        burst: async (name, frames) => {
          calls.push({ name, frames })
          return { bytes: frames * 4096 * 17 }
        },
      },
    }
    const page = {
      evaluate: async (callback, argument) =>
        new Function('window', 'argument', `return (${callback.toString()})(argument)`)(
          window,
          argument,
        ),
    }
    const run = {}
    const execute = new Function(
      'context',
      `
    const {phases, run, page, selectedOutputFixture, qualifiedWindow, measureCpu,
      browserSession, cpuOptions, outputFrames, manifest} = context;
    return (async () => { ${source.slice(blockStart, blockEnd)} })();
  `,
    )
    await execute({
      phases: ['output'],
      run,
      page,
      selectedOutputFixture: fixture.name,
      outputFrames: 1200,
      qualifiedWindow: async (_run, label, operation) => {
        assert.equal(label, `output/${name}`)
        return operation()
      },
      measureCpu: async (_browser, operation) => ({
        sample: await operation(),
        cpu: { milliseconds: 123 },
      }),
      manifest: { fixtures: [fixture] },
    })
    assert.deepEqual(calls, [
      { name: fixture.name, frames: 3 },
      { name: fixture.name, frames: 1200 },
    ])
    assert.equal(run.output.fixture, fixture.name)
    assert.deepEqual(run.output.input, fixture)
    assert.equal(run.output.bytes, 1200 * 4096 * 17)
    assert.equal(run.output.cpu.milliseconds, 123)
  })

test('failure artifacts retain control variant, write path, count, and repetition', async () => {
  const artifacts = await failureArtifacts({ variant: 'xterm-webgl', path: 'string', count: 17 }, 3)
  assert.deepEqual(artifacts, {
    screenshots: ['failure-xterm-webgl-string-17-3.png'],
    captures: ['capture-failure-xterm-webgl-string-17-3.png'],
  })
})

test('review 7: runner failure handler preserves rejected CPU and phase counter evidence', async () => {
  const workCounters = {
    status: 'incomplete',
    snapshots: { before: { processes: { 1: { values: { identity: '42' } } } } },
    processes: [{ pid: 1, identity: '42', instructions: 100 }],
    coverage: { matched: [1], errors: [{ pid: 2, reason: 'Process exited' }] },
  }
  const cpuFailure = { before: [{ id: 1 }, { id: 2 }], after: [{ id: 1 }], workCounters }
  const phaseFailure = {
    label: 'rejected',
    traced: true,
    cpu: cpuFailure,
    trace: 'retained.trace.json.gz',
  }
  const { run } = await failureArtifacts({ variant: 'ghostty-webgl', path: 'bytes', count: 1 }, 0, {
    cpuFailure,
    phaseFailure,
  })
  assert.equal(run.cpuFailure, cpuFailure)
  assert.equal(run.phaseFailure, phaseFailure)
  assert.equal(run.cpuFailure.workCounters.processes[0].instructions, 100)
  assert.equal(run.phaseFailure.trace, 'retained.trace.json.gz')
})

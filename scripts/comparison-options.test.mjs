import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analysisArguments, positiveInteger } from './comparison-options.mjs'

test('sample overrides require finite positive integers and a value', () => {
  for (const value of [undefined, '--output', 'NaN', 'Infinity', '1.5', '0', '-1']) {
    const args = value === undefined ? ['--samples'] : ['--samples', value]
    assert.throws(() => positiveInteger(args, '--samples', 48))
  }
  assert.equal(positiveInteger([], '--samples', 48), 48)
  assert.equal(positiveInteger(['--samples', '24'], '--samples', 48), 24)
})

test('compact analysis flag is never interpreted as an output filename', () => {
  assert.deepEqual(analysisArguments(['directory', '--compact']), {
    input: 'directory',
    output: undefined,
    compact: true,
  })
  assert.deepEqual(analysisArguments(['--compact', 'directory', 'output.json']), {
    input: 'directory',
    output: 'output.json',
    compact: true,
  })
  assert.throws(() => analysisArguments(['directory', '--unknown']))
})

test('Linux hardware runs are headless Vulkan and Mac measurements stay headed', async () => {
  const { hardwareLaunch } = await import('./comparison-options.mjs')
  assert.deepEqual(hardwareLaunch('linux', false), {
    headless: true,
    arguments: ['--enable-features=Vulkan', '--use-angle=vulkan', '--ignore-gpu-blocklist'],
  })
  assert.equal(hardwareLaunch('darwin', false).headless, false)
  assert.deepEqual(hardwareLaunch('linux', true).arguments, [])
})

test('measurement selections reject missing, unsupported and duplicate values', async () => {
  const { selection } = await import('./comparison-options.mjs')
  assert.deepEqual(selection(['--counts', '1,17'], '--counts', ['1'], ['1', '8', '17']), [
    '1',
    '17',
  ])
  for (const value of [undefined, '--output', '2', '1,1', ''])
    assert.throws(() => selection(['--counts', value], '--counts', ['1'], ['1', '8', '17']))
})

test('variant selection adds only the native renderer counterparts', async () => {
  const { variants } = await import('../bench/comparison-fixtures.ts')
  const { selectedVariants } = await import('./comparison-options.mjs')
  const available = variants.map(({ id }) => id)
  const fallback = ['ghostty-webgpu', 'xterm-webgl']
  assert.deepEqual(selectedVariants([], available, fallback), fallback)
  assert.deepEqual(
    selectedVariants(
      ['--variants', 'ghostty-webgl,ghostty-canvas,ghostty-dom'],
      available,
      fallback,
    ),
    ['ghostty-webgl', 'ghostty-canvas', 'ghostty-dom', 'xterm-webgl', 'ghostty-web', 'xterm-dom'],
  )
  assert.deepEqual(
    selectedVariants(['--variants', 'ghostty-webgpu,ghostty-webgl'], available, fallback),
    ['ghostty-webgpu', 'ghostty-webgl', 'xterm-webgl'],
  )
  for (const value of [undefined, '', 'unknown', 'ghostty-dom,ghostty-dom'])
    assert.throws(() => selectedVariants(['--variants', value], available, fallback))
})

test('GPU frame-builder selection supports one path and rejects conflicting selectors', async () => {
  const { frameBuilders } = await import('./comparison-options.mjs')
  assert.deepEqual(frameBuilders([]), ['js'])
  assert.deepEqual(frameBuilders(['--paired-frame-builders']), ['js', 'zig'])
  for (const value of ['js', 'zig', 'js,zig', 'zig,js'])
    assert.deepEqual(frameBuilders(['--frame-builders', value]), value.split(','))
  for (const value of [undefined, '', 'canvas', 'js,js'])
    assert.throws(() => frameBuilders(['--frame-builders', value]))
  assert.throws(() => frameBuilders(['--paired-frame-builders', '--frame-builders', 'zig']))
})

test('phase selection retains explicit narrow phases and rejects malformed values', async () => {
  const { selectedPhases, measurementPhases } = await import('./comparison-options.mjs')
  assert.deepEqual(selectedPhases([]), measurementPhases)
  assert.deepEqual(selectedPhases(['--phases', 'output,latency']), ['output', 'latency'])
  for (const phase of measurementPhases)
    assert.deepEqual(selectedPhases(['--phases', phase]), [phase])
  for (const value of [undefined, '', 'warmup', 'output,output'])
    assert.throws(() => selectedPhases(['--phases', value]))
})

test('output fixture defaults to ASCII and accepts exactly one committed manifest fixture', async () => {
  const { outputFixture } = await import('./comparison-options.mjs')
  const fixtures = [{ name: 'ascii' }, { name: 'logs' }, { name: 'rolling-logs' }]
  assert.equal(outputFixture([], fixtures), 'ascii')
  for (const name of fixtures.map(({ name }) => name))
    assert.equal(outputFixture(['--output-fixture', name], fixtures), name)
  for (const value of [undefined, '', '--output', 'unknown', 'ascii,logs', 'logs,logs'])
    assert.throws(() => outputFixture(['--output-fixture', value], fixtures))
  assert.throws(() => outputFixture([], [{ name: 'logs' }]))
})

test('trace phases preserve defaults and accept committed output fixtures', async () => {
  const { selectedTracePhases } = await import('./comparison-options.mjs')
  const fixtures = ['ascii', 'sgr', 'logs', 'rolling-logs'].map((name) => ({ name }))
  assert.deepEqual(selectedTracePhases([], fixtures), ['latency', 'ascii', 'sgr'])
  assert.deepEqual(selectedTracePhases(['--trace-phase', 'rolling-logs,latency'], fixtures), [
    'rolling-logs',
    'latency',
  ])
  for (const value of [undefined, '', 'unknown', 'rolling-logs,rolling-logs'])
    assert.throws(() => selectedTracePhases(['--trace-phase', value], fixtures))
})

test('even repetitions remain at least four and selected native/counterpart order is balanced', async () => {
  const { measurementRepetitions, measurementCases, counterparts } =
    await import('./comparison-options.mjs')
  for (const value of ['1', '2', '3', '5', '0', 'NaN'])
    assert.throws(() => measurementRepetitions(['--repetitions', value], 4))
  assert.equal(measurementRepetitions([], 4), 4)
  for (const repetitions of [4, 6, 8]) {
    const variants = Object.keys(counterparts).concat([...new Set(Object.values(counterparts))])
    const before = Object.fromEntries(Object.keys(counterparts).map((native) => [native, 0]))
    for (let repetition = 0; repetition < repetitions; repetition++) {
      const cases = measurementCases(variants, ['bytes', 'string'], [1, 17], ['zig'], repetition)
      for (const count of [1, 17])
        for (const path of ['bytes', 'string']) {
          const selected = cases.filter((entry) => entry.count === count && entry.path === path)
          assert.equal(selected.length, variants.length)
          assert.deepEqual(
            selected
              .filter((entry) => entry.frameBuilder)
              .map((entry) => entry.variant)
              .sort(),
            ['ghostty-webgl', 'ghostty-webgpu'],
          )
          for (const [native, counterpart] of Object.entries(counterparts)) {
            if (
              selected.findIndex((entry) => entry.variant === native) <
              selected.findIndex((entry) => entry.variant === counterpart)
            )
              before[native]++
          }
        }
    }
    for (const count of Object.values(before)) assert.equal(count, repetitions * 2)
  }
  for (const variant of ['ghostty-webgpu', 'ghostty-webgl']) {
    const native = (repetition) =>
      measurementCases([variant, 'xterm-webgl'], ['bytes'], [17], ['js', 'zig'], repetition)
        .filter((entry) => entry.variant === variant)
        .map((entry) => entry.frameBuilder)
    assert.deepEqual(native(0), ['js', 'zig'])
    assert.deepEqual(native(1), ['zig', 'js'])
  }
  assert.equal(
    measurementCases(
      ['ghostty-webgpu', 'ghostty-webgl', 'xterm-webgl'],
      ['bytes'],
      [1, 17],
      ['js', 'zig'],
      0,
    ).length,
    10,
  )
})

test('accessibility mode pairs native mirrors with xterm screen-reader mode', async () => {
  const { accessibilityMode } = await import('./comparison-options.mjs')
  assert.equal(accessibilityMode([]), 'off')
  assert.equal(accessibilityMode(['--accessibility', 'on']), 'on')
  assert.equal(accessibilityMode(['--accessibility', 'off']), 'off')
  assert.throws(() => accessibilityMode(['--accessibility', 'maybe']))
  assert.throws(() => accessibilityMode(['--accessibility', 'on,off']))
  assert.throws(() => accessibilityMode(['--accessibility']))
})

test('GPU command timeout selects the named trace budget and rejects invalid settings', async () => {
  const { settings } = await import('../bench/comparison-fixtures.ts')
  const { gpuCommandTimeout } = await import('./comparison-options.mjs')
  assert.equal(settings.gpuCommandTimeoutMilliseconds, 2000)
  assert.equal(settings.gpuTraceCommandTimeoutMilliseconds, 10000)
  assert.equal(gpuCommandTimeout(settings, false), 2000)
  assert.equal(gpuCommandTimeout(settings, true), 10000)
  for (const value of [undefined, 0, -1, NaN, Infinity, 1.5]) {
    assert.throws(() =>
      gpuCommandTimeout({ ...settings, gpuTraceCommandTimeoutMilliseconds: value }, true),
    )
    assert.throws(() =>
      gpuCommandTimeout({ ...settings, gpuCommandTimeoutMilliseconds: value }, false),
    )
  }
})

for (const tracing of [false, true]) {
  test(`${tracing ? 'trace' : 'ordinary'} GPU commands retain their effective timeout and fail closed`, async () => {
    const { settings } = await import('../bench/comparison-fixtures.ts')
    const { gpuCommandTimeout } = await import('./comparison-options.mjs')
    const { createGpuGate, GpuQualificationError } = await import('./comparison-gpu.mjs')
    const timeout = gpuCommandTimeout(settings, tracing)
    let time = 0
    let fail = false
    const timeouts = []
    const gate = createGpuGate(
      { ...settings, gpuCommandTimeoutMilliseconds: timeout },
      {
        platform: 'linux',
        now: () => time,
        sleep: async (milliseconds) => {
          time += milliseconds
        },
        command: async (_binary, args, options) => {
          timeouts.push(options.timeout)
          if (fail)
            throw Object.assign(new GpuQualificationError('Controlled timeout', null), {
              code: 'ETIMEDOUT',
            })
          return { stdout: args[0].startsWith('--query-gpu=') ? 'GPU-A, 0\n' : '', stderr: '' }
        },
      },
    )
    const idle = await gate.waitForIdle()
    const window = await gate.monitorWindow(async () => 'measured')
    assert.equal(idle.settings.gpuCommandTimeoutMilliseconds, timeout)
    assert.equal(window.gpu.settings.gpuCommandTimeoutMilliseconds, timeout)
    assert.equal(window.value, 'measured')
    assert.equal(window.gpu.qualified, true)
    assert(timeouts.length >= 10 && timeouts.every((value) => value === timeout))
    fail = true
    await assert.rejects(
      gate.monitorWindow(async () => assert.fail('Operation must not start')),
      (error) => {
        assert.equal(error.evidence.settings.gpuCommandTimeoutMilliseconds, timeout)
        assert.equal(error.evidence.qualified, false)
        assert.equal(error.evidence.samplingError.code, 'ETIMEDOUT')
        assert(
          error.evidence.samplingError.commands.every(
            (command) => command.timeoutMilliseconds === timeout,
          ),
        )
        return true
      },
    )
  })

  test(`${tracing ? 'trace' : 'ordinary'} runner preserves the effective GPU settings through recording and compaction`, async () => {
    const { randomUUID } = await import('node:crypto')
    const { settings } = await import('../bench/comparison-fixtures.ts')
    const { gpuCommandTimeout, measurementCases } = await import('./comparison-options.mjs')
    const { createGpuGate } = await import('./comparison-gpu.mjs')
    const { compactEvidence } = await import('./comparison-compact.mjs')
    const source = await readFile(new URL('./comparison-runner.mjs', import.meta.url), 'utf8')
    const start = source.indexOf('const s = manifest.settings')
    const end = source.indexOf('\nif (!smoke', start)
    const artifactStart = source.indexOf('const artifact = {')
    const artifactEnd = source.indexOf('\nconst artifactPath', artifactStart)
    const recordingStart = source.indexOf('artifact.environment.gpuIdleSettings =')
    const recordingEnd = source.indexOf('\n  for (let repetition', recordingStart)
    assert(start >= 0 && end > start)
    assert(artifactStart >= 0 && artifactEnd > artifactStart)
    assert(recordingStart >= 0 && recordingEnd > recordingStart)
    const context = {
      manifest: { settings },
      tracing,
      gpuCommandTimeout,
      createGpuGate,
      randomUUID,
      smoke: false,
      repetitions: settings.repetitions,
      latencySamples: settings.latencySamples,
      outputFrames: settings.outputFrames,
      selectedOutputFixture: 'ascii',
      accessibility: 'off',
      measurementCases,
      tickSeconds: null,
      counts: [1],
      variantIds: [],
      phases: [],
      builders: ['js'],
      writePaths: ['bytes'],
      fixtures: [],
      tracePhases: [],
      traceFrames: 1,
      gpuInfo: { gpu: { devices: [], featureStatus: {} } },
    }
    const initialize = new Function(
      ...Object.keys(context),
      `${source.slice(start, end)}\n${source.slice(artifactStart, artifactEnd)}\nartifact.environment.gpu = gpuInfo;\n${source.slice(recordingStart, recordingEnd)}\nreturn artifact`,
    )
    const artifact = initialize(...Object.values(context))
    const timeout = tracing ? 10000 : 2000
    assert.equal(artifact.gpuCommandTimeoutMilliseconds, timeout)
    assert.equal(artifact.environment.gpuIdleSettings.gpuCommandTimeoutMilliseconds, timeout)
    assert.deepEqual(artifact.manifest.settings, settings)
    const finalStart = source.lastIndexOf('} finally {\n  await writeFile(artifactPath,')
    const finalEnd = source.indexOf('  await browser?.close()', finalStart)
    assert(finalStart >= 0 && finalEnd > finalStart)
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    const writer = new AsyncFunction(
      'writeFile',
      'join',
      'artifactPath',
      'output',
      'artifact',
      source.slice(finalStart + '} finally {'.length, finalEnd),
    )
    const output = await mkdtemp(join(tmpdir(), 'ghostty-trace-timeout-'))
    try {
      await writer(writeFile, join, join(output, 'comparison.json'), output, artifact)
      const comparison = JSON.parse(await readFile(join(output, 'comparison.json'), 'utf8'))
      const qualification = JSON.parse(await readFile(join(output, 'qualification.json'), 'utf8'))
      assert.equal(comparison.gpuCommandTimeoutMilliseconds, timeout)
      assert.equal(comparison.environment.gpuIdleSettings.gpuCommandTimeoutMilliseconds, timeout)
      assert.equal(qualification.gpuCommandTimeoutMilliseconds, timeout)
      assert.equal(qualification.environment.gpuIdleSettings.gpuCommandTimeoutMilliseconds, timeout)
      const compact = JSON.parse(JSON.stringify(await compactEvidence(comparison)))
      assert.equal(compact.gpuCommandTimeoutMilliseconds, timeout)
      assert.equal(compact.environment.gpuIdleSettings.gpuCommandTimeoutMilliseconds, timeout)
    } finally {
      await rm(output, { recursive: true, force: true })
    }
  })
}

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { platform, release } from 'node:os'
import { chromium, type CDPSession, type Page } from 'playwright'
import { displayedInk } from './displayed-ink'
import type { BenchmarkBackend, BenchmarkScenario } from '../bench/renderer-benchmark-types'

const root = join(import.meta.dirname, '..')
const allowedScenarios: readonly BenchmarkScenario[] = [
  'settled-idle',
  'cursor-movement',
  'burst-output',
  'sustained-scroll',
  'glyph-churn',
]
const scenarioNames = (process.env.BENCH_SCENARIOS ?? allowedScenarios.join(',')).split(',')
const scenarios = allowedScenarios.filter((scenario) => scenarioNames.includes(scenario))
assert(
  scenarios.length > 0 && scenarios.length === scenarioNames.length,
  'Unknown or repeated BENCH_SCENARIOS',
)
const allowedBackends: readonly BenchmarkBackend[] = ['canvas2d', 'webgl2', 'webgpu', 'ghostty-web']
const requested = (process.env.BENCH_BACKENDS ?? 'canvas2d,webgl2,webgpu').split(',')
const backends = allowedBackends.filter((backend) => requested.includes(backend))
assert(
  backends.length === requested.length && backends.length > 0,
  'Unknown or repeated BENCH_BACKENDS',
)
const steps = positiveInteger('BENCH_STEPS', 120)
const repetitions = positiveInteger('BENCH_REPETITIONS', 3)
const warmupSteps = positiveInteger('BENCH_WARMUP_STEPS', 20)
const idleMilliseconds = positiveInteger('BENCH_SAMPLE_SECONDS', 2) * 1000
const headless = process.env.BENCH_HEADLESS === '1'
const output = resolve(process.env.BENCH_OUTPUT ?? join(root, '.artifacts/renderer-benchmark.json'))
const origin = 'http://localhost:41799'
const candidates = [{ label: 'candidate', root }]
if (process.env.BENCH_BASELINE_ROOT)
  candidates.unshift({ label: 'before', root: resolve(process.env.BENCH_BASELINE_ROOT) })

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  assert(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`)
  return value
}

interface ProcessCpu {
  id: number
  type: string
  cpuTime: number
}

async function processes(session: CDPSession): Promise<readonly ProcessCpu[]> {
  const response: unknown = await session.send('SystemInfo.getProcessInfo')
  assert(
    response &&
      typeof response === 'object' &&
      'processInfo' in response &&
      Array.isArray(response.processInfo),
  )
  return response.processInfo.map((entry: unknown) => {
    assert(
      entry && typeof entry === 'object' && 'id' in entry && 'type' in entry && 'cpuTime' in entry,
    )
    assert(
      typeof entry.id === 'number' &&
        typeof entry.type === 'string' &&
        typeof entry.cpuTime === 'number',
    )
    return { id: entry.id, type: entry.type, cpuTime: entry.cpuTime }
  })
}

function cpuDelta(
  before: readonly ProcessCpu[],
  after: readonly ProcessCpu[],
  milliseconds: number,
) {
  const prior = new Map(before.map((process) => [process.id, process]))
  const groups: Record<string, number> = {}
  for (const process of after) {
    const delta = Math.max(0, process.cpuTime - (prior.get(process.id)?.cpuTime ?? 0))
    groups[process.type] = (groups[process.type] ?? 0) + delta
  }
  const totalSeconds = Object.values(groups).reduce((sum, value) => sum + value, 0)
  const afterIds = new Set(after.map((process) => process.id))
  return {
    secondsByProcessType: groups,
    totalSeconds,
    percentOfOneCore: (totalSeconds / (milliseconds / 1000)) * 100,
    processChurn:
      before.some((process) => !afterIds.has(process.id)) ||
      after.some((process) => !prior.has(process.id)),
  }
}

function distribution(samples: readonly number[]) {
  const sorted = [...samples].sort((left, right) => left - right)
  return {
    count: samples.length,
    median: sorted[Math.floor(sorted.length / 2)] ?? 0,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
    samples,
  }
}

async function buildBrowserBundle(sourceRoot: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(root, 'bench/renderer-benchmark-entry.ts')],
    format: 'esm',
    target: 'browser',
    plugins: [
      {
        name: 'benchmark-source',
        setup(build) {
          build.onResolve({ filter: /^\.\.\/src\// }, (args) => ({
            path: join(sourceRoot, args.path.slice(3).replace(/\.js$/u, '.ts')),
          }))
        },
      },
    ],
  })
  assert(result.success && result.outputs[0], 'Benchmark browser bundle failed')
  return result.outputs[0].text()
}

async function routePage(page: Page, bundle: string, sourceRoot: string): Promise<void> {
  const [wasm, bridge] = await Promise.all([
    readFile(join(sourceRoot, 'ghostty-vt.wasm')),
    readFile(join(sourceRoot, 'bridge.wasm')),
  ])
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/bundle.js')
      return route.fulfill({ body: bundle, contentType: 'text/javascript' })
    if (url.pathname === '/ghostty-vt.wasm')
      return route.fulfill({ body: wasm, contentType: 'application/wasm' })
    if (url.pathname === '/bridge.wasm')
      return route.fulfill({ body: bridge, contentType: 'application/wasm' })
    if (url.pathname !== '/') return route.abort()
    await route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><style>body{margin:0;background:black}main{width:1600px;height:900px}</style><main></main><script type="module" src="/bundle.js"></script>',
    })
  })
}

const args = [
  '--enable-unsafe-webgpu',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]
if (!headless && process.platform === 'linux' && process.env.WAYLAND_DISPLAY)
  args.push('--ozone-platform=wayland')
const browser = await chromium.launch({ channel: 'chromium', headless, args })
const browserSession = await browser.newBrowserCDPSession()
const gpuInfo: unknown = await browserSession.send('SystemInfo.getInfo')
const hardware = hardwareRenderer(gpuInfo)
const results: Awaited<ReturnType<typeof measure>>[] = []
const sourceArtifacts: unknown[] = []
let completed = false
await mkdir(dirname(output), { recursive: true })

function hardwareRenderer(info: unknown): boolean {
  if (!info || typeof info !== 'object' || !('gpu' in info)) return false
  const gpu = info.gpu
  if (!gpu || typeof gpu !== 'object' || !('auxAttributes' in gpu)) return false
  const attributes = gpu.auxAttributes
  if (!attributes || typeof attributes !== 'object' || !('glRenderer' in attributes)) return false
  return (
    typeof attributes.glRenderer === 'string' &&
    !/swiftshader|llvmpipe|software/i.test(attributes.glRenderer)
  )
}

async function measure(
  source: (typeof candidates)[number],
  backend: BenchmarkBackend,
  scenario: BenchmarkScenario,
  repetition: number,
  bundle: string,
) {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
  })
  page.setDefaultTimeout(15_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    await routePage(page, bundle, source.root)
    await page.goto(`${origin}/?backend=${backend}`)
    await page.waitForFunction(() => Boolean(window.__rendererBench), null, { timeout: 30_000 })
    await page.bringToFront()
    const pixels = await displayedInk(page)
    assert(pixels.red > 20, `${backend} did not present red glyphs`)
    await page.evaluate(
      ({ scenario, warmupSteps }) => window.__rendererBench.run(scenario, warmupSteps, 100),
      { scenario, warmupSteps },
    )
    const before = await processes(browserSession)
    const started = performance.now()
    const result = await page.evaluate(
      ({ scenario, steps, idleMilliseconds }) =>
        window.__rendererBench.run(scenario, steps, idleMilliseconds),
      { scenario, steps, idleMilliseconds },
    )
    const after = await processes(browserSession)
    const cpu = cpuDelta(before, after, performance.now() - started)
    const info = await page.evaluate(() => window.__rendererBench.getPageInfo())
    if (!headless && backend === 'webgpu') {
      assert(info && typeof info === 'object' && 'adapter' in info)
      const adapter = info.adapter
      assert(
        adapter &&
          typeof adapter === 'object' &&
          'fallback' in adapter &&
          adapter.fallback === false,
        'Software WebGPU adapter cannot qualify performance',
      )
    }
    const pageSession = await page.context().newCDPSession(page)
    const memory: unknown = await pageSession.send('Runtime.getHeapUsage')
    await page.locator('main canvas').screenshot({
      path: join(
        dirname(output),
        `${basename(output, '.json')}-${source.label}-${backend}-${scenario}-${repetition}.png`,
      ),
    })
    const terminalText = await page.evaluate(() => window.__rendererBench.output())
    await page.evaluate(() => window.__rendererBench.dispose())
    assert.deepEqual(errors, [])
    if (backend !== 'ghostty-web' && scenario === 'settled-idle')
      assert.equal(result.frameRequests, 0, 'Idle renderer scheduled frames')
    const { callbackMilliseconds, writeMilliseconds, ...counts } = result
    return {
      source: source.label,
      backend,
      scenario,
      repetition,
      info,
      cpu,
      memory,
      ...counts,
      outputSha256: createHash('sha256').update(terminalText).digest('hex'),
      callbackMilliseconds: distribution(callbackMilliseconds),
      writeMilliseconds: distribution(writeMilliseconds),
    }
  } finally {
    await page.close()
  }
}

try {
  const bundles = new Map<string, string>()
  for (const source of candidates) {
    const bundle = await buildBrowserBundle(source.root)
    bundles.set(source.label, bundle)
    const bundlePath = join(
      dirname(output),
      `${basename(output, '.json')}.${source.label}.bundle.js`,
    )
    await Bun.write(bundlePath, bundle)
    sourceArtifacts.push({
      label: source.label,
      root: source.root,
      revision: Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: source.root })
        .stdout.toString()
        .trim(),
      bundlePath,
      bundleSha256: createHash('sha256').update(bundle).digest('hex'),
      wasmSha256: createHash('sha256')
        .update(await readFile(join(source.root, 'ghostty-vt.wasm')))
        .digest('hex'),
      bridgeSha256: createHash('sha256')
        .update(await readFile(join(source.root, 'bridge.wasm')))
        .digest('hex'),
    })
  }
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const ordered = repetition % 2 === 0 ? candidates : [...candidates].reverse()
    for (const scenario of scenarios) await measureScenario(ordered, scenario, repetition, bundles)
  }
  completed = true
} finally {
  await Bun.write(
    output,
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        sourceArtifacts,
        environment: {
          os: platform(),
          release: release(),
          browser: browser.version(),
          args,
          headless,
          gpuInfo,
        },
        protocol: {
          steps,
          repetitions,
          warmupSteps,
          idleMilliseconds,
          performanceQualified:
            completed &&
            !headless &&
            hardware &&
            repetitions >= 3 &&
            results.every((result) => !result.cpu.processChurn),
          notes:
            'CPU deltas sum browser processes. Callback/write times measure JS, not input-to-photon latency. Startup, native/GPU memory and physical input are unmeasured.',
        },
        results,
      },
      null,
      2,
    ) + '\n',
  )
  await browser.close()
}

async function measureScenario(
  ordered: typeof candidates,
  scenario: BenchmarkScenario,
  repetition: number,
  bundles: ReadonlyMap<string, string>,
): Promise<void> {
  const orderedBackends = repetition % 2 === 0 ? backends : [...backends].reverse()
  for (const backend of orderedBackends) {
    for (const source of ordered)
      await measureSource(source, backend, scenario, repetition, bundles)
  }
}

async function measureSource(
  source: (typeof candidates)[number],
  backend: BenchmarkBackend,
  scenario: BenchmarkScenario,
  repetition: number,
  bundles: ReadonlyMap<string, string>,
): Promise<void> {
  const bundle = bundles.get(source.label)
  assert(bundle)
  const result = await measure(source, backend, scenario, repetition, bundle)
  const paired = results.find(
    (previous) =>
      previous.backend === backend &&
      previous.scenario === scenario &&
      previous.repetition === repetition &&
      previous.source !== source.label,
  )
  results.push(result)
  if (paired) {
    assert.equal(result.steps, paired.steps, 'Paired workloads processed different steps')
    assert.equal(
      result.writtenBytes,
      paired.writtenBytes,
      'Paired workloads processed different bytes',
    )
    assert.equal(
      result.outputSha256,
      paired.outputSha256,
      'Paired workloads produced different text',
    )
  }
  console.log(
    `${source.label} ${backend} ${scenario} #${repetition + 1}: ${result.cpu.percentOfOneCore.toFixed(1)}% CPU, callback p95 ${result.callbackMilliseconds.p95.toFixed(2)}ms, ${result.writtenBytes} bytes`,
  )
}
console.log(`Evidence: ${output}`)

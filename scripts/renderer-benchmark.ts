import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { platform, release } from 'node:os'
import { chromium, type CDPSession, type Page } from 'playwright'
import { displayedInk } from './displayed-ink'
import { measureCpu } from './comparison-guards.mjs'
import { benchmarkBackends } from '../bench/renderer-benchmark-types'
import type { BenchmarkBackend, BenchmarkScenario } from '../bench/renderer-benchmark-types'

const root = join(import.meta.dirname, '..')
const allowedScenarios: readonly BenchmarkScenario[] = [
  'settled-idle',
  'cursor-movement',
  'burst-output',
  'sustained-scroll',
  'glyph-churn',
  'sparse-edit',
  'dense-redraw',
  'warm-unicode',
  'cold-cache',
  'resize-dpr',
  'cursor-blink',
  'hidden-output',
  'external',
]
const scenarioNames = (
  process.env.BENCH_SCENARIOS ?? allowedScenarios.filter((name) => name !== 'external').join(',')
).split(',')
const scenarios = allowedScenarios.filter((scenario) => scenarioNames.includes(scenario))
assert(
  scenarios.length > 0 && scenarios.length === scenarioNames.length,
  'Unknown or repeated BENCH_SCENARIOS',
)
const requested = (process.env.BENCH_BACKENDS ?? 'canvas2d,webgl2,webgpu').split(',')
const backends = benchmarkBackends.filter((backend) => requested.includes(backend))
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
  const sorted = samples.toSorted((left, right) => left - right)
  return {
    count: samples.length,
    p99: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] ?? 0,
    median: sorted[Math.floor(sorted.length / 2)] ?? 0,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
    samples,
  }
}

let workerBundle = ''
async function buildBrowserBundle(sourceRoot: string): Promise<string> {
  if (process.env.BENCH_PREBUILT_BUNDLE) {
    if (process.env.BENCH_PREBUILT_WORKER)
      workerBundle = await readFile(process.env.BENCH_PREBUILT_WORKER, 'utf8')
    return readFile(process.env.BENCH_PREBUILT_BUNDLE, 'utf8')
  }
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
  if (process.env.BENCH_WORKER === '1') {
    const built = await Bun.build({
      entrypoints: [join(root, 'bench/renderer-diagnostic-worker.mjs')],
      format: 'esm',
      target: 'browser',
    })
    assert(built.success && built.outputs[0])
    workerBundle = await built.outputs[0].text()
    await Bun.write(output + '.worker.js', workerBundle)
  }
  return result.outputs[0].text()
}

async function routePage(
  page: Page,
  bundle: string,
  sourceRoot: string,
  workload?: string,
): Promise<void> {
  const [wasm, bridge, canvasCompose] = await Promise.all([
    readFile(join(sourceRoot, 'ghostty-vt.wasm')),
    readFile(join(sourceRoot, 'bridge.wasm')),
    readFile(join(sourceRoot, 'canvas-compose.wasm')),
  ])
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/diagnostic-worker.js')
      return route.fulfill({ body: workerBundle, contentType: 'text/javascript' })
    if (url.pathname === '/font.woff2')
      return route.fulfill({
        body: await readFile(
          join(
            root,
            'node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2',
          ),
        ),
        contentType: 'font/woff2',
      })
    if (url.pathname === '/workload.bin')
      return route.fulfill({
        body: await readFile((workload ?? process.env.BENCH_WORKLOAD) + '.bin'),
        contentType: 'application/octet-stream',
      })
    if (url.pathname === '/workload.json')
      return route.fulfill({
        body: await readFile((workload ?? process.env.BENCH_WORKLOAD) + '.json'),
        contentType: 'application/json',
      })
    if (url.pathname === '/bundle.js')
      return route.fulfill({ body: bundle, contentType: 'text/javascript' })
    if (url.pathname === '/ghostty-vt.wasm')
      return route.fulfill({ body: wasm, contentType: 'application/wasm' })
    if (url.pathname === '/bridge.wasm')
      return route.fulfill({ body: bridge, contentType: 'application/wasm' })
    if (url.pathname === '/canvas-compose.wasm')
      return route.fulfill({ body: canvasCompose, contentType: 'application/wasm' })
    if (url.pathname !== '/') return route.abort()
    await route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><style>body{margin:0;background:black}main{width:1600px;height:900px;display:flex;flex-wrap:wrap;align-content:flex-start}canvas{max-width:${Math.floor(1600 / Math.ceil(Math.sqrt(Number(process.env.BENCH_COUNT ?? 1))))}px;max-height:${Math.floor(900 / Math.ceil(Math.sqrt(Number(process.env.BENCH_COUNT ?? 1))))}px;object-fit:contain}</style><main></main><script type="module" src="/bundle.js"></script>`,
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
const reusedPage =
  process.env.BENCH_REUSE_PAGE === '1'
    ? await browser.newPage({
        viewport: { width: 1600, height: 1000 },
        deviceScaleFactor: Number(process.env.BENCH_DPR ?? 2),
      })
    : undefined
const browserSession = await browser.newBrowserCDPSession()
const gpuInfo: unknown = await browserSession.send('SystemInfo.getInfo')
const fullLaunchArgv = await (async () => {
  try {
    if (platform() !== 'linux') return await browserSession.send('Browser.getBrowserCommandLine')
    const process = (await processes(browserSession)).find((entry) => entry.type === 'browser')
    assert(process, 'Owned browser process required')
    return {
      arguments: (await readFile(`/proc/${process.id}/cmdline`, 'utf8'))
        .split('\0')
        .filter(Boolean),
      source: 'owned CDP browser pid /proc cmdline',
    }
  } catch (cause) {
    return { unavailable: String(cause) }
  }
})()
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
  const page =
    reusedPage ??
    (await browser.newPage({
      viewport: { width: 1600, height: 1000 },
      deviceScaleFactor: Number(process.env.BENCH_DPR ?? 2),
    }))
  page.setDefaultTimeout(15_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(message.text())
  })
  try {
    const workloads = process.env.BENCH_WORKLOADS?.split(',')
    const workload = workloads?.[repetition % workloads.length] ?? process.env.BENCH_WORKLOAD
    await routePage(page, bundle, source.root, workload)
    const query = new URLSearchParams({
      backend,
      columns: process.env.BENCH_COLUMNS ?? '200',
      rows: process.env.BENCH_ROWS ?? '50',
      count: process.env.BENCH_COUNT ?? '1',
      history: process.env.BENCH_HISTORY ?? '200',
      scrollback: process.env.BENCH_SCROLLBACK ?? '10000',
    })
    if (process.env.BENCH_HOSTED === '1') query.set('hosted', '')
    if (process.env.BENCH_WORKER === '1') {
      query.set('worker', '')
      query.set('hosted', '')
    }
    if (process.env.BENCH_DEFAULT_GPU === '1') query.set('defaultGpu', '')
    if (workload) query.set('workload', workload)
    const traced =
      process.env.BENCH_TRACE_ABBA === '1'
        ? repetition === 1 || repetition === 2
        : process.env.BENCH_TRACE === '1'
    if (traced) query.set('trace', '')
    if (process.env.BENCH_COMPLETION === '1') query.set('completion', '')
    if (process.env.BENCH_TIMESTAMP === '1') query.set('timestamp', '')
    await page.goto(`${origin}/?${query}`)
    assert.deepEqual(errors, [], `${backend} failed during page initialization`)
    const startupError = new Promise<never>((_, reject) => page.once('pageerror', reject))
    await Promise.race([
      page.waitForFunction(
        () => Boolean(window.__rendererBench || window.__rendererBenchFailure),
        null,
        {
          timeout: 30_000,
        },
      ),
      startupError,
    ])
    const drawFailure = await page.evaluate(() => window.__rendererBenchFailure)
    assert(!drawFailure, `${backend} renderer draw failed: ${drawFailure}`)
    await page.bringToFront()
    const pixels = await displayedInk(page)
    assert(pixels.red > 20, `${backend} did not present red glyphs`)
    if (process.env.BENCH_COLD !== '1')
      await page.evaluate(
        ({ scenario, warmupSteps }) => window.__rendererBench.run(scenario, warmupSteps, 100),
        { scenario, warmupSteps },
      )
    const before = await processes(browserSession)
    const started = performance.now()
    const operation = () => page.evaluate(
      ({ scenario, steps, idleMilliseconds }) =>
        window.__rendererBench.run(scenario, steps, idleMilliseconds),
      { scenario, steps, idleMilliseconds },
    )
    const nativeMeasurement = process.env.BENCH_ENERGY === '1'
      ? await measureCpu(browserSession, operation, { processCounters: true })
      : { sample: await operation(), cpu: null }
    const result = nativeMeasurement.sample
    const after = await processes(browserSession)
    const cpu = cpuDelta(before, after, performance.now() - started)
    const info = await page.evaluate(() => window.__rendererBench.getPageInfo())
    if (!headless && backend.startsWith('webgpu')) {
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
    await pageSession.send('HeapProfiler.collectGarbage')
    const memory: unknown = await pageSession.send('Runtime.getHeapUsage')
    if (process.env.BENCH_SCREENSHOTS !== '0')
      await page
        .locator('main canvas')
        .first()
        .screenshot({
          path: join(
            dirname(output),
            `${basename(output, '.json')}-${source.label}-${backend}-${scenario}-${repetition}.png`,
          ),
        })
    const terminalText = await page.evaluate(() => window.__rendererBench.output())
    const lateDrawFailure = await page.evaluate(() => window.__rendererBenchFailure)
    assert(!lateDrawFailure, `${backend} renderer draw failed: ${lateDrawFailure}`)
    const workerMemory = process.env.BENCH_WORKER === '1' ? await workerHeaps() : []
    await page.evaluate(() => window.__rendererBench.dispose())
    assert.deepEqual(errors, [])
    if (backend !== 'ghostty-web' && scenario === 'settled-idle')
      assert.equal(result.frameRequests, 0, 'Idle renderer scheduled frames')
    const { callbackMilliseconds, writeMilliseconds, ...counts } = result
    return {
      source: source.label,
      workload,
      backend,
      scenario,
      repetition,
      info,
      cpu,
      memory,
      nativeCpu: nativeMeasurement.cpu,
      workerHeaps: workerMemory,
      ...counts,
      outputSha256: createHash('sha256').update(terminalText).digest('hex'),
      callbackMilliseconds: distribution(callbackMilliseconds),
      writeMilliseconds: distribution(writeMilliseconds),
    }
  } finally {
    if (reusedPage) {
      await page.unrouteAll({ behavior: 'wait' })
      page.removeAllListeners('pageerror')
      page.removeAllListeners('console')
    } else await page.close()
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
      canvasComposeSha256: createHash('sha256')
        .update(await readFile(join(source.root, 'canvas-compose.wasm')))
        .digest('hex'),
    })
  }
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const ordered = repetition % 2 === 0 ? candidates : candidates.toReversed()
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
          fullLaunchArgv,
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
  const orderedBackends = repetition % 2 === 0 ? backends : backends.toReversed()
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

async function workerHeaps() {
  const { targetInfos } = await browserSession.send('Target.getTargets')
  const heaps = []
  for (const target of targetInfos.filter((entry) => entry.type === 'worker')) {
    try {
      heaps.push({ target, heap: await targetHeap(target.targetId) })
    } catch (error) {
      heaps.push({ target, error: String(error) })
    }
  }
  return heaps
}
async function targetHeap(targetId: string) {
  const { sessionId } = await browserSession.send('Target.attachToTarget', { targetId, flatten: false })
  let listener: (event: { sessionId: string; message: string }) => void
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const response = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Worker Runtime.getHeapUsage timeout')), 5000)
      listener = (event) => {
        if (event.sessionId !== sessionId) return
        const message = JSON.parse(event.message)
        if (message.id === 501) resolve(message)
      }
      browserSession.on('Target.receivedMessageFromTarget', listener)
    })
    await browserSession.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: 501, method: 'Runtime.getHeapUsage' }) })
    return await response
  } finally {
    clearTimeout(timer)
    browserSession.off('Target.receivedMessageFromTarget', listener!)
    await browserSession.send('Target.detachFromTarget', { sessionId })
  }
}

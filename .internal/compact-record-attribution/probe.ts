import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'
import type { Browser, CDPSession, Page } from 'playwright'
type Scenario = 'ntcharts-heatmap' | 'opentui-plasma' | 'changing-dense'
type Arm = 'released' | 'extracted' | 'timed' | 'positive'
import type {} from './hooks.ts'
import type { BenchmarkResult } from '../../bench/renderer-benchmark-types.ts'
declare global {
  interface Window {
    __attributionPrepare(chunks: number[][]): void
    __attributionRun(start?: number, end?: number): Promise<BenchmarkResult>
    __attributionReplay(chunks: number[][]): Promise<BenchmarkResult>
  }
}

const root = process.env.G5_REPO
const output = process.env.G5_OUTPUT
const scratch = process.env.G5_SCRATCH
assert(root && output && scratch && process.env.DISPLAY)
const args = [
  '--enable-automation',
  '--ozone-platform=x11',
  '--ignore-gpu-blocklist',
  '--enable-unsafe-webgpu',
  '--use-angle=vulkan',
  '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan',
  '--disable-vulkan-surface',
]
const server = createServer((_request, response) =>
  response.end('<!doctype html><title>Owned baseline control</title>'),
)
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
assert(address && typeof address !== 'string')
const origin = `http://127.0.0.1:${address.port}`
const bundles = new Map<string, string>()
const results: Awaited<ReturnType<typeof measure>>[] = []
let browser: Browser | undefined
let cdp: CDPSession | undefined
let metadata: unknown
let capability: unknown
function hash(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex')
}
async function bundle() {
  const entry = join(root!, 'bench/renderer-benchmark-entry.ts')
  const source = await readFile(entry, 'utf8')
  const hooks = await readFile(join(import.meta.dirname, 'hooks.ts'), 'utf8')
  const extension = await readFile(join(import.meta.dirname, 'page.ts'), 'utf8')
  const built = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    format: 'esm',
    plugins: [
      {
        name: 'baseline-hooks',
        setup(build) {
          build.onLoad({ filter: /renderer-benchmark-entry\.ts$/ }, () => ({
            contents: hooks + '\n' + source + '\n' + extension,
            loader: 'ts',
            resolveDir: join(root!, 'bench'),
          }))
          build.onResolve({ filter: /^ghostty-source\// }, (args) => ({
            path: join(root!, 'src', args.path.slice('ghostty-source/'.length)),
          }))
        },
      },
    ],
  })
  assert(built.success, built.logs.join('\n'))
  assert(built.outputs[0])
  return built.outputs[0].text()
}
async function cpu() {
  assert(cdp)
  return (await cdp.send('SystemInfo.getProcessInfo')).processInfo
}
function cpuDifference(
  before: Awaited<ReturnType<typeof cpu>>,
  after: Awaited<ReturnType<typeof cpu>>,
) {
  const previous = new Map(before.map((entry) => [entry.id, entry]))
  const seconds: Record<string, number> = {}
  for (const entry of after)
    seconds[entry.type] =
      (seconds[entry.type] ?? 0) +
      Math.max(0, entry.cpuTime - (previous.get(entry.id)?.cpuTime ?? entry.cpuTime))
  const afterIds = new Set(after.map((entry) => entry.id))
  return {
    seconds,
    churn:
      before.some((entry) => !afterIds.has(entry.id)) ||
      after.some((entry) => !previous.has(entry.id)),
  }
}
async function route(page: Page, code: string, arm: Arm) {
  assert(root)
  const assets = new Map<string, { body: Buffer | string; contentType: string }>([
    ['/bundle.js', { body: code, contentType: 'text/javascript' }],
    [
      '/',
      {
        body: '<!doctype html><style>body{margin:0;background:black}</style><main></main><script type="module" src="/bundle.js"></script>',
        contentType: 'text/html',
      },
    ],
  ])
  for (const file of ['ghostty-vt.wasm', 'bridge.wasm', 'canvas-compose.wasm'])
    assets.set('/' + file, {
      body: await readFile(join(root, file)),
      contentType: 'application/wasm',
    })
  assets.set('/font', {
    body: await readFile(
      join(
        root,
        'node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2',
      ),
    ),
    contentType: 'font/woff2',
  })
  if (arm !== 'released')
    assets.set('/bridge.wasm', {
      body: await readFile(join(scratch!, arm === 'extracted' ? 'extracted.wasm' : 'timed.wasm')),
      contentType: 'application/wasm',
    })
  await page.route(origin + '/**', async (intercepted) => {
    const asset = assets.get(new URL(intercepted.request().url()).pathname)
    if (!asset) return intercepted.abort()
    return intercepted.fulfill({
      ...asset,
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    })
  })
}
async function measure(
  backend: 'webgpu' | 'webgl2',
  scenario: Scenario,
  arm: Arm,
  repetition: number,
) {
  assert(browser && cdp)
  const page = await browser.newPage({
    viewport: { width: 1800, height: 1000 },
    deviceScaleFactor: 2,
  })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    const code = bundles.get(arm)
    assert(code)
    await route(page, code, arm)
    const columns = scenario === 'changing-dense' ? 200 : 100
    const rows = scenario === 'changing-dense' ? 50 : 30
    await page.goto(`${origin}/?backend=${backend}&columns=${columns}&rows=${rows}&count=1&font=1`)
    await page.waitForFunction(
      () => Boolean(window.__rendererBench || window.__rendererBenchFailure),
      null,
      { timeout: 30000 },
    )
    assert.deepEqual(errors, [])
    assert.equal(await page.evaluate(() => window.__rendererBenchFailure), undefined)
    assert(await page.evaluate(() => crossOriginIsolated))
    const qualification = await page.evaluate(() =>
      window.__attributionReplay([
        Array.from(new TextEncoder().encode('\x1b[?25l\x1b[48;2;64;128;192m\x1b[2J')),
      ]),
    )
    const painted = readPng(await page.locator('canvas').first().screenshot())
    let paintedPixels = 0
    for (let i = 0; i < painted.data.length; i += 4)
      paintedPixels += Number(
        painted.data[i] === 64 && painted.data[i + 1] === 128 && painted.data[i + 2] === 192,
      )
    assert(
      paintedPixels / (painted.width * painted.height) > 0.999,
      'Entire backing must paint solid qualification color',
    )
    const chunks = workloads.get(scenario)
    assert(chunks)
    await page.evaluate((chunks) => window.__attributionPrepare(chunks), chunks)
    const positive = await page.evaluate(() => window.__attributionRun(0, 4))
    assert((positive.metrics.submittedFrames ?? 0) > 0 && (positive.metrics.bridgeBuilds ?? 0) > 0)
    await page.evaluate(() => window.__attributionRun(0, 8))
    const warmPixels = readPng(await page.locator('canvas').first().screenshot())
    assert.notEqual(
      hash(warmPixels.data),
      hash(painted.data),
      'Application must replace solid paint before timing',
    )
    await page.evaluate(
      (repetitions) => window.__nativeProbe.reset(repetitions),
      arm === 'positive' ? 32 : 1,
    )
    const beforeStats = await page.evaluate(() => window.__recordProbe?.stats)
    const beforeCpu = await cpu()
    const measured = await page.evaluate(() => window.__attributionRun())
    const afterCpu = await cpu()
    const native = await page.evaluate(() => window.__nativeProbe.read())
    const afterStats = await page.evaluate(() => window.__recordProbe?.stats)
    const attribution =
      beforeStats && afterStats
        ? Object.fromEntries(
            Object.entries(afterStats).map(([key, value]) => [
              key,
              value - beforeStats[key as keyof typeof beforeStats],
            ]),
          )
        : undefined
    const records = await page.evaluate(() => window.__recordProbe?.records())
    const recordDigests = await page.evaluate(() => window.__recordDigests())
    const info = await page.evaluate(() => window.__rendererBench.getPageInfo())
    const text = await page.evaluate(() => window.__rendererBench.output())
    const pixels = readPng(await page.locator('canvas').first().screenshot())
    let redPixels = 0
    for (let index = 0; index < pixels.data.length; index += 4)
      redPixels += Number(
        pixels.data[index]! > 100 && pixels.data[index + 1]! < 50 && pixels.data[index + 2]! < 50,
      )
    assert(pixels.width === painted.width && pixels.height === painted.height)
    assert.notEqual(
      hash(pixels.data),
      hash(painted.data),
      'Workload output must not remain the qualification image',
    )
    assert.deepEqual(errors, [])
    assert.equal(await page.evaluate(() => window.__rendererBenchFailure), undefined)
    await page.evaluate(() => window.__rendererBench.dispose())
    return {
      backend,
      scenario,
      arm,
      repetition,
      native,
      recordDigests,
      warmPixelHash: hash(warmPixels.data),
      qualification: {
        pixelHash: hash(painted.data),
        paintedPixels,
        width: painted.width,
        height: painted.height,
        qualification,
      },
      measured,
      attribution,
      records,
      info,
      cpu: cpuDifference(beforeCpu, afterCpu),
      textHash: hash(text),
      pixelHash: hash(pixels.data),
      width: pixels.width,
      height: pixels.height,
      redPixels,
      positive,
    }
  } finally {
    await page.close()
  }
}
const workloads = new Map<Scenario, number[][]>()
const workloadInputs = []
const workloadRoot = '/work/reports/ghostty-webgpu-next-2026-10/p0b/workloads'
for (const name of ['ntcharts-heatmap', 'opentui-plasma'] as const) {
  const meta: unknown = JSON.parse(await readFile(join(workloadRoot, name + '.json'), 'utf8'))
  const bytes = await readFile(join(workloadRoot, name + '.bin'))
  const chunks = fixtureChunks(meta, bytes)
  workloads.set(name, chunks)
  workloadInputs.push({ name, meta, framedHash: hash(JSON.stringify(chunks)) })
}
workloads.set(
  'changing-dense',
  Array.from({ length: 64 }, (_, step) =>
    Array.from(
      new TextEncoder().encode(
        '\x1b[?25l\x1b[0m\x1b[H' +
          Array.from({ length: 50 }, (_, y) =>
            Array.from({ length: 200 }, (_, x) =>
              String.fromCharCode(33 + ((x * 17 + y * 13 + step) % 90)),
            ).join(''),
          ).join('\r\n'),
      ),
    ),
  ),
)
await writeFile(join(output, 'inputs.json'), JSON.stringify(workloadInputs, null, 2))
try {
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: false, args })
  cdp = await browser.newBrowserCDPSession()
  const commandLine = await cdp.send('Browser.getBrowserCommandLine')
  assert(!commandLine.arguments.some((arg) => arg.startsWith('--headless')))
  metadata = {
    version: browser.version(),
    commandLine,
    system: await cdp.send('SystemInfo.getInfo'),
    display: process.env.DISPLAY,
    origin,
  }
  const page = await browser.newPage()
  try {
    await page.goto(origin)
    const original = await readFile(
      '/work/reports/wave-20261106/audits2/ghostty-webgpu/007-hardware-tool/probe.ts',
      'utf8',
    ).catch(() => readFile(join(import.meta.dirname, '../007-hardware-tool/probe.ts'), 'utf8'))
    const functions = original.slice(
      original.indexOf('async function probePage()'),
      original.indexOf('const output = process.env.PROBE_OUTPUT'),
    )
    const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(functions)
    capability = await page.evaluate(`(async () => { ${javascript}; return probePage(); })()`)
    const serialized = JSON.stringify(capability)
    assert(!/swiftshader|llvmpipe|lavapipe/i.test(serialized))
    assert(
      capability &&
        typeof capability === 'object' &&
        'webgpu' in capability &&
        'webgl2' in capability,
    )
    const { webgpu, webgl2 } = capability
    assert(
      webgpu &&
        typeof webgpu === 'object' &&
        'positiveControl' in webgpu &&
        webgpu.positiveControl === true,
    )
    assert(
      webgl2 &&
        typeof webgl2 === 'object' &&
        'positiveControl' in webgl2 &&
        webgl2.positiveControl === true,
    )
  } finally {
    await page.close()
  }
  const code = await bundle()
  for (const arm of ['released', 'timed', 'positive']) bundles.set(arm, code)
  for (const backend of ['webgpu', 'webgl2'] as const) await measureBackend(backend)
} finally {
  await browser?.close()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  await writeFile(
    join(output, 'acquisition.json'),
    JSON.stringify(
      {
        delivery: 'prepared-u8',
        source: Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root }).stdout.toString().trim(),
        metadata,
        capability,
        bundleHashes: Object.fromEntries(Array.from(bundles, ([name, code]) => [name, hash(code)])),
        performanceQualified: false,
        note: 'Bounded PC main renderer attribution, one terminal, not an acceptance matrix or worker comparison. No candidate.',
        results,
      },
      null,
      2,
    ),
  )
}
async function measureBackend(backend: 'webgpu' | 'webgl2') {
  for (const scenario of ['ntcharts-heatmap', 'opentui-plasma', 'changing-dense'] as const)
    await measureScenario(backend, scenario)
}
async function measureScenario(backend: 'webgpu' | 'webgl2', scenario: Scenario) {
  for (let repetition = 0; repetition < 2; repetition++)
    await measureRepetition(backend, scenario, repetition)
}
async function measureRepetition(
  backend: 'webgpu' | 'webgl2',
  scenario: Scenario,
  repetition: number,
) {
  const arms: Arm[] = ['released', 'timed', 'positive']
  if (repetition === 1) arms.reverse()
  const pair = []
  for (const arm of arms) {
    const result = await measure(backend, scenario, arm, repetition)
    results.push(result)
    pair.push(result)
    console.log(
      backend,
      scenario,
      arm,
      repetition,
      JSON.stringify({ metrics: result.measured.metrics, native: result.native, cpu: result.cpu }),
    )
  }
  for (const result of pair) {
    assert.deepEqual(result.recordDigests, pair[0]!.recordDigests)
    assert.equal(result.textHash, pair[0]!.textHash)
    assert.equal(result.pixelHash, pair[0]!.pixelHash)
    for (const key of [
      'submittedFrames',
      'uploadedBytes',
      'instanceUploadOperations',
      'acknowledgements',
      'acknowledgedRows',
      'rebuiltRows',
      'bridgeBuilds',
    ])
      assert.equal(result.measured.metrics[key], pair[0]!.measured.metrics[key], key)
  }
}

function readPng(bytes: Uint8Array) {
  const value = PNG.sync.read(bytes)
  assert(value !== null && typeof value === 'object')
  assert(
    'width' in value &&
      typeof value.width === 'number' &&
      Number.isSafeInteger(value.width) &&
      value.width > 0,
  )
  assert(
    'height' in value &&
      typeof value.height === 'number' &&
      Number.isSafeInteger(value.height) &&
      value.height > 0,
  )
  assert('data' in value && Buffer.isBuffer(value.data))
  assert.equal(value.data.length, value.width * value.height * 4)
  return { width: value.width, height: value.height, data: value.data }
}

function fixtureChunks(value: unknown, bytes: Buffer): number[][] {
  assert(value !== null && typeof value === 'object')
  assert('sha256' in value && typeof value.sha256 === 'string')
  assert.equal(hash(bytes), value.sha256)
  assert('cols' in value && value.cols === 100)
  assert('rows' in value && value.rows === 30)
  assert('chunks' in value && Array.isArray(value.chunks) && value.chunks.length === 64)
  let expectedOffset = 0
  const chunks = Array.from(value.chunks, (chunk: unknown) => {
    assert(chunk !== null && typeof chunk === 'object')
    assert(
      'offset' in chunk && typeof chunk.offset === 'number' && Number.isSafeInteger(chunk.offset),
    )
    assert(
      'length' in chunk &&
        typeof chunk.length === 'number' &&
        Number.isSafeInteger(chunk.length) &&
        chunk.length > 0,
    )
    assert.equal(chunk.offset, expectedOffset)
    expectedOffset += chunk.length
    assert(expectedOffset <= bytes.length)
    return Array.from(bytes.subarray(chunk.offset, expectedOffset))
  })
  assert.equal(expectedOffset, bytes.length)
  return chunks
}

// X7 research instrument: counterbalanced main-entry publication cost at 200x50, DPR 2.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { chromium, type Browser, type CDPSession } from 'playwright'

const root = join(import.meta.dirname, '..')
const origin = 'http://localhost:41811'
const env = (name: string, fallback: string) => process.env[name] ?? fallback
const backends = env('X7_BACKENDS', 'webgl2,webgpu,dom').split(',')
const counts = env('X7_COUNTS', '1,16').split(',').map(Number)
const workloads = env('X7_WORKLOADS', 'dense,scroll').split(',')
const observerModes = env('X7_OBSERVERS', 'off,on').split(',')
const repetitions = Number(env('X7_REPETITIONS', '2'))
const steps = Number(env('X7_STEPS', '180'))
const warmup = Number(env('X7_WARMUP', '30'))
const headless = env('X7_HEADLESS', '0') === '1'
const parity = env('X7_PARITY', 'off')
const discard = env('X7_DISCARD', 'off')
const output = resolve(env('X7_OUTPUT', join(root, '.artifacts/x7-publication.json')))
const arms = [
  {
    label: 'before',
    root: resolve(env('X7_BEFORE_ROOT', join(root, '../x7-before'))),
  },
  { label: 'after', root },
]

async function bundle(sourceRoot: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(root, 'bench/x7-publication-entry.ts')],
    format: 'esm',
    target: 'browser',
    plugins: [
      {
        name: 'arm-source',
        setup(build) {
          build.onResolve({ filter: /^\.\.\/src\// }, (args) => ({
            path: join(sourceRoot, args.path.slice(3).replace(/\.js$/u, '.ts')),
          }))
        },
      },
    ],
  })
  assert(result.success && result.outputs[0], 'bundle failed')
  return result.outputs[0].text()
}

interface Cpu {
  id: number
  type: string
  cpuTime: number
}
async function processes(session: CDPSession): Promise<Cpu[]> {
  const response = (await session.send('SystemInfo.getProcessInfo')) as {
    processInfo: Cpu[]
  }
  return response.processInfo
}
function cpuPercent(before: Cpu[], after: Cpu[], ms: number, type: string): number {
  const prior = new Map(before.map((entry) => [entry.id, entry.cpuTime]))
  let seconds = 0
  for (const entry of after) {
    if (entry.type !== type) continue
    seconds += entry.cpuTime - (prior.get(entry.id) ?? 0)
  }
  return (seconds * 100_000) / ms
}

function freeVram(): number | undefined {
  if (process.platform !== 'linux') return undefined
  const text = execFileSync(
    'nvidia-smi',
    ['--query-gpu=memory.free', '--format=csv,noheader,nounits'],
    {
      encoding: 'utf8',
    },
  )
  return Number(text.trim().split('\n')[0])
}

async function measure(
  browser: Browser,
  browserSession: CDPSession,
  arm: (typeof arms)[number],
  code: string,
  cell: Record<string, string | number>,
) {
  const page = await browser.newPage({
    viewport: { width: 1800, height: 1000 },
    deviceScaleFactor: 2,
  })
  page.setDefaultTimeout(60_000)
  const [wasm, bridge, compose] = await Promise.all(
    ['ghostty-vt.wasm', 'bridge.wasm', 'canvas-compose.wasm'].map((name) =>
      readFile(join(arm.root, name)),
    ),
  )
  await page.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/bundle.js') return route.fulfill({ body: code, contentType: 'text/javascript' })
    if (path === '/ghostty-vt.wasm')
      return route.fulfill({ body: wasm!, contentType: 'application/wasm' })
    if (path === '/bridge.wasm')
      return route.fulfill({ body: bridge!, contentType: 'application/wasm' })
    if (path === '/canvas-compose.wasm')
      return route.fulfill({ body: compose!, contentType: 'application/wasm' })
    if (path !== '/') return route.abort()
    return route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><style>body{margin:0;background:black}main{width:1800px;height:1000px}</style><main></main><script type="module" src="/bundle.js"></script>',
    })
  })
  try {
    const query = new URLSearchParams(
      Object.entries(cell).map(([key, value]) => [key, String(value)]),
    )
    await page.goto(`${origin}/?${query}`)
    await page.waitForFunction(() => Boolean(window.__x7 || window.__x7Failure), null, {
      timeout: 60_000,
    })
    const failure = await page.evaluate(() => window.__x7Failure)
    if (failure) throw new Error(failure)
    await page.bringToFront()
    await page.evaluate((count) => window.__x7!.run(count), warmup)
    const pageSession = await page.context().newCDPSession(page)
    await pageSession.send('Performance.enable')
    const readMetrics = async () => {
      const response = (await pageSession.send('Performance.getMetrics')) as {
        metrics: { name: string; value: number }[]
      }
      return (name: string) => response.metrics.find((entry) => entry.name === name)?.value ?? 0
    }
    const metricsBefore = await readMetrics()
    const before = await processes(browserSession)
    const started = performance.now()
    const run = await page.evaluate((count) => window.__x7!.run(count), steps)
    const after = await processes(browserSession)
    const elapsed = performance.now() - started
    const metricsAfter = await readMetrics()
    const delta = (name: string) => metricsAfter(name) - metricsBefore(name)
    await pageSession.send('HeapProfiler.collectGarbage')
    const metric = await readMetrics()
    const digest = await page.evaluate(() => window.__x7!.digest())
    const info = await page.evaluate(() => window.__x7!.info())
    assert.equal(await page.evaluate(() => window.__x7Failure), undefined)
    return {
      arm: arm.label,
      ...cell,
      elapsedMs: elapsed,
      frames: run.frames,
      texts: run.texts,
      parsedWrites: run.parsedWrites,
      submitted: run.submitted,
      presented: run.presented,
      observerDigest: run.observerDigest,
      rendererCpu: cpuPercent(before, after, elapsed, 'renderer'),
      gpuCpu: cpuPercent(before, after, elapsed, 'GPU'),
      jsHeapUsed: metric('JSHeapUsedSize'),
      scriptMs: (delta('ScriptDuration') * 1000) / run.frames,
      taskMs: (delta('TaskDuration') * 1000) / run.frames,
      wasmBytes: info.wasmBytes,
      adapter: info.adapter,
      digest,
    }
  } finally {
    await page.close()
  }
}

function assertPair(pair: readonly Awaited<ReturnType<typeof measure>>[]): void {
  const [before, after] = pair
  assert(before && after, 'Expected two measurement arms')
  for (const field of ['frames', 'texts', 'parsedWrites', 'submitted', 'observerDigest'] as const)
    assert.equal(before[field], after[field], `${field} differs`)
}

const codes = new Map<string, string>()
for (const arm of arms) codes.set(arm.label, await bundle(arm.root))
const results: unknown[] = []
const sources = Object.fromEntries(
  arms.map((arm) => [
    arm.label,
    process.env[`X7_${arm.label.toUpperCase()}_SHA`] ??
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: arm.root, encoding: 'utf8' }).trim(),
  ]),
)
let browserVersion = ''
const packet = () => ({ steps, warmup, sources, browserVersion, results })
await mkdir(dirname(output), { recursive: true })
for (const backend of backends) {
  const vram = freeVram()
  assert(vram === undefined || vram >= 2048, `Free VRAM ${vram} MiB is under 2 GiB`)
  const args = [
    '--enable-unsafe-webgpu',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ]
  if (!headless && process.platform === 'linux' && process.env.WAYLAND_DISPLAY)
    args.push('--ozone-platform=wayland')
  if (process.platform === 'linux' && backend === 'webgpu') args.push('--enable-features=Vulkan')
  const browser = await chromium.launch({
    channel: 'chromium',
    headless,
    args,
  })
  try {
    browserVersion = browser.version()
    const browserSession = await browser.newBrowserCDPSession()
    const gpu = (await browserSession.send('SystemInfo.getInfo')) as {
      gpu: { auxAttributes?: { glRenderer?: string } }
    }
    const renderer = gpu.gpu.auxAttributes?.glRenderer ?? 'unknown'
    for (const count of counts)
      for (const workload of workloads)
        for (const observers of observerModes)
          for (let repetition = 0; repetition < repetitions; repetition += 1) {
            const order = repetition % 2 === 0 ? arms : arms.toReversed()
            const pair = []
            for (const arm of order) {
              const result = await measure(browser, browserSession, arm, codes.get(arm.label)!, {
                backend,
                count,
                workload,
                observers,
                parity,
                discard,
              })
              pair.push(result)
              results.push({ ...result, repetition, glRenderer: renderer })
              console.log(JSON.stringify({ ...result, repetition }))
            }
            assert.equal(
              pair[0]!.digest,
              pair[1]!.digest,
              `text differs for ${backend}/${count}/${workload}/${observers}`,
            )
            assertPair(pair)
            await writeFile(output, JSON.stringify(packet(), null, 2))
          }
  } finally {
    await browser.close()
  }
}
await writeFile(output, JSON.stringify(packet(), null, 2))

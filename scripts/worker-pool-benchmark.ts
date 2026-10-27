import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { chromium, type CDPSession, type Page } from 'playwright'

const root = join(import.meta.dirname, '..')
const output = resolve(process.env.WORKER_POOL_OUTPUT ?? join(root, '.artifacts/worker-pool.json'))
const steps = Number(process.env.WORKER_POOL_STEPS ?? 60)
const repetitions = Number(process.env.WORKER_POOL_REPETITIONS ?? 2)
const headless = process.env.WORKER_POOL_HEADLESS === '1'
const origin = 'http://localhost:41807'
const port = 41808
const modes = ['control', 'pool'] as const
const counts = process.env.WORKER_POOL_COUNTS?.split(',').map(Number) ?? [4, 16]
const geometries = [
  { columns: 200, rows: 50 },
  { columns: 80, rows: 24 },
]
const hashes = (values: readonly string[][]) =>
  values.map((rows) => createHash('sha256').update(rows.join('\n')).digest('hex'))

function quantiles(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b)
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
  return { count: samples.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), samples }
}

async function bundle(entrypoint: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(root, entrypoint)],
    format: 'esm',
    target: 'browser',
    plugins: [
      {
        name: 'receive-timing',
        setup(build) {
          build.onLoad({ filter: /src\/worker\/execution\.ts$/u }, async ({ path }) => {
            const source = await readFile(path, 'utf8')
            const before =
              'this.port.onmessage = ({ data }: MessageEvent<WorkerMessage>) => this.receive(data)'
            const after = `this.port.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
          const started = performance.now()
          this.receive(data)
          if (data.type === 'frame') window.__workerReceiveMilliseconds += performance.now() - started
        }`
            assert(source.includes(before), 'worker timing patch no longer matches')
            return { contents: source.replace(before, after), loader: 'ts' }
          })
        },
      },
    ],
  })
  assert(
    result.success && result.outputs[0],
    `bundle failed ${entrypoint}: ${result.logs.join('\n')}`,
  )
  return result.outputs[0].text()
}

class RawCdp {
  private id = 0
  private readonly pending = new Map<
    number,
    {
      resolve(value: Record<string, unknown>): void
      reject(cause: unknown): void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private constructor(private readonly socket: WebSocket) {
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(String(data))
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
      else pending.resolve(message.result)
    }
  }
  static async connect(): Promise<RawCdp> {
    const discovery = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) =>
      response.json(),
    )
    assert(typeof discovery.webSocketDebuggerUrl === 'string')
    const socket = new WebSocket(discovery.webSocketDebuggerUrl)
    await new Promise<void>((resolveReady, reject) => {
      socket.onopen = () => resolveReady()
      socket.onerror = reject
    })
    return new RawCdp(socket)
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = ++this.id
    const result = new Promise<Record<string, unknown>>((resolveResult, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP timeout ${method}`))
      }, 10_000)
      this.pending.set(id, { resolve: resolveResult, reject, timer })
    })
    this.socket.send(JSON.stringify({ id, method, params, sessionId }))
    return result
  }
  close(): void {
    this.socket.close()
  }
}

async function workerHeaps(cdp: RawCdp) {
  const targets = await cdp.send('Target.getTargets')
  assert(Array.isArray(targets.targetInfos))
  const heaps: Record<string, unknown>[] = []
  for (const target of targets.targetInfos) {
    if (target.type !== 'worker') continue
    const attached = await cdp.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    })
    assert(typeof attached.sessionId === 'string')
    const heap = await cdp.send('Runtime.getHeapUsage', {}, attached.sessionId)
    heaps.push({ targetId: target.targetId, url: target.url, ...heap })
    await cdp.send('Target.detachFromTarget', { sessionId: attached.sessionId })
  }
  return heaps
}

async function processes(
  cdp: CDPSession,
): Promise<{ id: number; type: string; cpuTime: number }[]> {
  const result = await cdp.send('SystemInfo.getProcessInfo')
  return result.processInfo
}

async function workerCpuTicks(processIds: number[]): Promise<number> {
  let ticks = 0
  for (const pid of processIds) ticks += await processWorkerTicks(pid)
  return ticks
}

async function processWorkerTicks(pid: number): Promise<number> {
  const tasks = await readdir(`/proc/${pid}/task`).catch(() => [])
  let ticks = 0
  for (const tid of tasks) {
    const text = await readFile(`/proc/${pid}/task/${tid}/stat`, 'utf8').catch(() => '')
    if (!text.includes('(DedicatedWorker')) continue
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
    ticks += Number(fields[11]) + Number(fields[12])
  }
  return ticks
}

async function processMemory(processIds: number[]) {
  let pssKiB = 0
  let rssKiB = 0
  for (const pid of processIds) {
    const text = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8').catch(() => '')
    pssKiB += Number(/^Pss:\s+(\d+)/mu.exec(text)?.[1] ?? 0)
    rssKiB += Number(/^Rss:\s+(\d+)/mu.exec(text)?.[1] ?? 0)
  }
  return { pssKiB, rssKiB }
}

async function route(page: Page, assets: Map<string, string | Buffer>): Promise<void> {
  await page.route(`${origin}/**`, async (request) => {
    const pathname = new URL(request.request().url()).pathname
    const body = assets.get(pathname)
    if (!body) return request.abort()
    const contentType = pathname.endsWith('.wasm')
      ? 'application/wasm'
      : pathname.endsWith('.woff2')
        ? 'font/woff2'
        : pathname.endsWith('.js')
          ? 'text/javascript'
          : 'text/html'
    await request.fulfill({ body, contentType })
  })
}

async function measure(
  mode: (typeof modes)[number],
  count: number,
  columns: number,
  rows: number,
  repetition: number,
  assets: Map<string, string | Buffer>,
) {
  const args = [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    `--remote-debugging-port=${port}`,
  ]
  if (!headless && process.env.WAYLAND_DISPLAY) args.push('--ozone-platform=wayland')
  const freeMiB = Number(
    Bun.spawnSync(['nvidia-smi', '--query-gpu=memory.free', '--format=csv,noheader,nounits'])
      .stdout.toString()
      .trim(),
  )
  if (!headless) assert(freeMiB >= 2048, `only ${freeMiB} MiB VRAM free`)
  const browser = await chromium.launch({ channel: 'chromium', headless, args })
  let raw: RawCdp | undefined
  try {
    raw = await RawCdp.connect()
    const browserCdp = await browser.newBrowserCDPSession()
    const gpuInfo = await browserCdp.send('SystemInfo.getInfo')
    if (!headless)
      assert(
        !/swiftshader|llvmpipe|software/iu.test(String(gpuInfo.gpu.auxAttributes?.glRenderer)),
        'hardware adapter required',
      )
    const page = await browser.newPage({
      viewport: { width: 2400, height: 1800 },
      deviceScaleFactor: 2,
    })
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error')
        pageErrors.push(message.text())
    })
    await route(page, assets)
    await page.goto(origin)
    await page.evaluate(
      ({ mode, count, columns, rows }) =>
        window.__workerPoolBench.setup(mode, count, columns, rows),
      { mode, count, columns, rows },
    )
    const workerHeap = await workerHeaps(raw)
    assert.equal(workerHeap.length, mode === 'pool' ? 1 : count, 'worker target count')
    const pageCdp = await page.context().newCDPSession(page)
    await pageCdp.send('Performance.enable', { timeDomain: 'threadTicks' })
    await page.evaluate(() => window.__workerPoolBench.sample(8))
    const warm = await page.evaluate(() => window.__workerPoolBench.report())
    const before = await processes(browserCdp)
    const processIds = before.map((process) => process.id)
    const beforeTicks = await workerCpuTicks(processIds)
    const beforeMetrics = await pageCdp.send('Performance.getMetrics')
    const started = performance.now()
    await page.evaluate((count) => window.__workerPoolBench.sample(count), steps)
    const elapsed = performance.now() - started
    const afterMetrics = await pageCdp.send('Performance.getMetrics')
    const afterTicks = await workerCpuTicks(processIds)
    const after = await processes(browserCdp)
    const report = await page.evaluate(() => window.__workerPoolBench.report())
    const liveHeaps = await workerHeaps(raw)
    const pageHeap = await pageCdp.send('Runtime.getHeapUsage')
    const memory = await processMemory(after.map((process) => process.id))
    const prefix = `${mode}-${count}-${columns}x${rows}-${repetition}`
    const screenshots: string[] = []
    for (let index = 0; index < count; index += 1) {
      const png = await page
        .locator('canvas')
        .nth(index)
        .screenshot({ path: join(dirname(output), `${prefix}-${index}.png`) })
      screenshots.push(createHash('sha256').update(png).digest('hex'))
    }
    const metric = (name: string) =>
      (afterMetrics.metrics.find((metric) => metric.name === name)?.value ?? 0) -
      (beforeMetrics.metrics.find((metric) => metric.name === name)?.value ?? 0)
    const delivered = report.deliveredFrames.map(
      (value, index) => value - warm.deliveredFrames[index]!,
    )
    const receipt = {
      mode,
      count,
      columns,
      rows,
      repetition,
      steps,
      elapsedMilliseconds: elapsed,
      browser: browser.version(),
      gpuInfo,
      args,
      freeMiB,
      pageErrors,
      cpu: {
        workerSeconds: (afterTicks - beforeTicks) / 100,
        hostTaskSeconds: metric('TaskDuration'),
        hostScriptSeconds: metric('ScriptDuration'),
        before,
        after,
      },
      pageHeap,
      workerHeaps: liveHeaps,
      memory,
      hostHandlerMilliseconds: report.hostHandlerMilliseconds - warm.hostHandlerMilliseconds,
      hostTaskMillisecondsPerFrame:
        (metric('TaskDuration') * 1000) / delivered.reduce((sum, value) => sum + value, 0),
      acknowledgement: quantiles(report.acknowledgements.slice(warm.acknowledgements.length)),
      deliveredFrames: delivered,
      writeCounts: report.writeCounts.map((value, index) => value - warm.writeCounts[index]!),
      rowHashes: hashes(report.rows),
      screenshots,
      errors: report.errors,
      bytes: report.bytes - warm.bytes,
      lifecycle:
        mode === 'pool'
          ? await page
              .evaluate(() => window.__workerPoolBench.lifecycle())
              .catch((error: unknown) => ({
                failure: error instanceof Error ? error.message : String(error),
              }))
          : undefined,
    }
    await page.evaluate(() => window.__workerPoolBench.dispose())
    return receipt
  } finally {
    raw?.close()
    await browser.close()
  }
}

await mkdir(dirname(output), { recursive: true })
const assets = new Map<string, string | Buffer>([
  [
    '/',
    '<!doctype html><style>body{margin:0;background:#000}main{display:flex;flex-direction:column;gap:4px}canvas{max-width:none}</style><main></main><script type="module" src="/page.js"></script>',
  ],
  ['/page.js', await bundle('bench/worker-pool-page.ts')],
  ['/worker.js', await bundle('bench/worker-pool-worker.ts')],
  ['/control-worker.js', await bundle('src/worker/entry.ts')],
  ['/ghostty-vt.wasm', await readFile(join(root, 'ghostty-vt.wasm'))],
  ['/bridge.wasm', await readFile(join(root, 'bridge.wasm'))],
  [
    '/fonts/JetBrainsMono-Regular.woff2',
    await readFile(
      join(
        root,
        'node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2',
      ),
    ),
  ],
])
const results: unknown[] = []
try {
  for (let repetition = 0; repetition < repetitions; repetition += 1)
    await runRepetition(repetition)
} finally {
  await Bun.write(
    output,
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        source: Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim(),
        headless,
        steps,
        repetitions,
        results,
      },
      null,
      2,
    ),
  )
}
async function runRepetition(repetition: number) {
  const order = repetition % 2 === 0 ? modes : modes.toReversed()
  for (const geometry of geometries) await runGeometry(geometry, repetition, order)
}
async function runGeometry(
  geometry: (typeof geometries)[number],
  repetition: number,
  order: readonly (typeof modes)[number][],
) {
  for (const count of counts) await runPair(count, geometry, repetition, order)
}
async function runPair(
  count: number,
  geometry: (typeof geometries)[number],
  repetition: number,
  order: readonly (typeof modes)[number][],
) {
  for (const mode of order) {
    console.log(`sample ${mode} ${count} ${geometry.columns}x${geometry.rows} r${repetition}`)
    const result = await measure(mode, count, geometry.columns, geometry.rows, repetition, assets)
    results.push(result)
    await Bun.write(output, JSON.stringify({ results }, null, 2))
  }
}

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { chromium, type CDPSession, type Page } from 'playwright'
import { swiftShaderArgs, swiftShaderEnv } from './swiftshader-launch.mjs'
import {
  analyze,
  commonBase,
  endpointNames,
  type ResearchReceipt,
  type Sample,
  type WorkerReading,
  qualifyHardware,
} from './worker-revision-summary.js'
import type {} from '../bench/worker-revision-page.js'

const root = resolve(import.meta.dirname, '..')
const control = process.env.WORKER_REVISION_CONTROL_ROOT
assert(control, 'WORKER_REVISION_CONTROL_ROOT is required; there is no sibling default')
const output = resolve(process.env.WORKER_REVISION_OUTPUT ?? '.artifacts/worker-revision.json')
const headless = process.env.WORKER_REVISION_HEADLESS === '1'
const parity = process.env.WORKER_REVISION_PARITY === '1'
assert(!parity || headless, 'per-frame hashing is correctness-only, never timed hardware work')
const steps = positive(process.env.WORKER_REVISION_STEPS ?? '60')
const repetitions = positive(process.env.WORKER_REVISION_REPETITIONS ?? '2')
const fixtures = process.env.WORKER_REVISION_FIXTURES?.split(',') ?? [
  'sustained-logs',
  'unicode-varied',
]
const counts = process.env.WORKER_REVISION_COUNTS?.split(',').map(positive) ?? [4, 16]
const geometries = [
  { columns: 200, rows: 50 },
  { columns: 80, rows: 24 },
]
const origin = 'http://localhost:41917'
const port = 41918
const warmup = 8
function positive(value: string): number {
  const result = Number(value)
  assert(Number.isSafeInteger(result) && result > 0)
  return result
}
function sha(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}
function git(directory: string, args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', directory].concat(args))
  assert.equal(result.exitCode, 0, result.stderr.toString())
  return result.stdout.toString().trim()
}
const allowed = new Set([
  'src/core/displayed-frame.ts',
  'src/worker/protocol.ts',
  'src/worker/revision-publisher.ts',
  'src/worker/revision-reception.ts',
  'src/worker/runtime.ts',
  'src/worker/execution.ts',
  'src/worker/revision-publication.test.ts',
  'src/worker/terminal.browser.test.ts',
  'src/worker/tests/revision-tamper.worker.ts',
  'src/dom/tests/terminal-ui.browser.test.ts',
  'bench/worker-revision-page.ts',
  'scripts/worker-revision-benchmark.ts',
  'scripts/worker-revision-summary.ts',
  'scripts/worker-revision-summary.test.ts',
  'vitest.config.ts',
  '.internal/worker-revision-publication.md',
  '.internal/worker-revision-publication-results.json',
  '.internal/worker-delta-prototype/codec.ts',
  '.internal/worker-delta-prototype/codec.test.ts',
  '.internal/worker-delta-prototype/transport.ts',
])
async function provenance() {
  assert.equal(git(control!, ['rev-parse', 'HEAD']), commonBase)
  assert.equal(git(control!, ['status', '--porcelain']), '', 'control must remain clean')
  assert.equal(git(root, ['status', '--porcelain']), '', 'commit candidate before comparison')
  git(root, ['merge-base', '--is-ancestor', commonBase, 'HEAD'])
  const paths = git(root, ['diff', '--name-only', commonBase, 'HEAD']).split('\n').filter(Boolean)
  assert(
    paths.every((path) => allowed.has(path)),
    `out-of-scope paths: ${paths.filter((path) => !allowed.has(path))}`,
  )
  for (const asset of ['ghostty-vt.wasm', 'bridge.wasm'])
    assert.equal(sha(await readFile(join(root, asset))), sha(await readFile(join(control!, asset))))
  return {
    base: commonBase,
    candidate: git(root, ['rev-parse', 'HEAD']),
    control: commonBase,
    scopeChecked: true,
    wasmEqual: true,
  }
}
function replace(source: string, before: string, after: string): string {
  assert.equal(
    source.split(before).length,
    2,
    `instrumentation anchor must match exactly once: ${before}`,
  )
  return source.replace(before, after)
}
function instrumentHost(source: string): string {
  source = replace(
    source,
    'this.port.onmessage = ({ data }: MessageEvent<WorkerMessage>) => this.receive(data)',
    `this.port.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
    const received = performance.timeOrigin + performance.now()
    this.receive(data)
    const completed = performance.timeOrigin + performance.now()
    if (data.experimentTiming) window.__revisionTimings.push({...data.experimentTiming,received,completed})
    if (data.type === 'frame') window.__workerReceiveMilliseconds += completed-received
  }`,
  )
  return replace(
    source,
    'this.frameListener?.(this.textFrame()!)',
    'this.frameListener?.(this.textFrame()!)',
  )
}
function instrumentWorker(source: string): string {
  const prefix = `const requests = new Map<number,{queue:number;execute?:number}>()
  const now=()=>performance.timeOrigin+performance.now()
  `
  source = replace(
    source,
    'async start(): Promise<void> {',
    'async start(): Promise<void> {\n    globalThis.__revisionRuntime = this',
  )
  source = replace(
    source,
    'const request = event.data',
    "const request = event.data\n    if (request.type === 'request') requests.set(request.control,{queue:now()})",
  )
  source = replace(
    source,
    'private async execute(request: WorkerRequest): Promise<void> {',
    'private async execute(request: WorkerRequest): Promise<void> {\n    const entry = requests.get(request.control); if(entry) entry.execute=now()',
  )
  source = replace(
    source,
    'this.initialize.port.postMessage(message)',
    `const at=now()
    const entry=requests.get(message.control)
    const timing={...entry,terminal:message.terminal,control:message.control,kind:message.type,at,end:now()}
    this.initialize.port.postMessage({...message,experimentTiming:timing})`,
  )
  return prefix + source
}
async function bundle(armRoot: string, worker: boolean): Promise<string> {
  const entry = worker
    ? join(armRoot, 'src/worker/entry.ts')
    : join(root, 'bench/worker-revision-page.ts')
  const result = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    format: 'esm',
    plugins: [
      {
        name: 'same-instrumentation-both-arms',
        setup(build) {
          build.onResolve({ filter: /^\.\.\/src\//u }, ({ path, importer }) =>
            importer === join(root, 'bench/worker-revision-page.ts')
              ? { path: resolve(armRoot, 'bench', path.replace(/\.js$/u, '.ts')) }
              : undefined,
          )
          build.onLoad({ filter: /src\/worker\/(execution|runtime)\.ts$/u }, async ({ path }) => ({
            contents: path.endsWith('/execution.ts')
              ? instrumentHost(await readFile(path, 'utf8'))
              : instrumentWorker(await readFile(path, 'utf8')),
            loader: 'ts',
          }))
        },
      },
    ],
  })
  assert(result.success && result.outputs[0], result.logs.join('\n'))
  return result.outputs[0].text()
}

async function bounded<Value>(promise: Promise<Value>): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('007 operation exceeded 60 seconds')), 60_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
class RawCdp {
  readonly trace: Record<string, unknown>[] = []
  private traceComplete = Promise.withResolvers<void>()
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
      if (message.method === 'Tracing.tracingComplete') this.traceComplete.resolve()
      if (message.method === 'Tracing.dataCollected') this.trace.push(...message.params.value)
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
      else pending.resolve(message.result)
    }
  }
  static async connect(): Promise<RawCdp> {
    const discovery = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(10_000),
    }).then((response) => response.json())
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
  async startTrace(): Promise<void> {
    this.trace.length = 0
    this.traceComplete = Promise.withResolvers<void>()
    await this.send('Tracing.start', {
      categories: '-*,toplevel,v8,disabled-by-default-v8.gc',
      transferMode: 'ReportEvents',
    })
  }
  async endTrace(): Promise<void> {
    await this.send('Tracing.end')
    await bounded(this.traceComplete.promise)
  }
  close(): void {
    this.socket.close()
  }
}

function numeric(value: unknown): number {
  assert(
    typeof value === 'number' && Number.isFinite(value) && value >= 0,
    'finite endpoint required',
  )
  return value
}
function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
async function workerStates(cdp: RawCdp): Promise<WorkerReading[]> {
  const targets = await cdp.send('Target.getTargets')
  assert(Array.isArray(targets.targetInfos))
  const states: WorkerReading[] = []
  for (const entry of targets.targetInfos) {
    const target = object(entry)
    if (target.type !== 'worker') continue
    states.push(await workerState(cdp, target))
  }
  states.sort((left, right) => left.ordinal - right.ordinal)
  return states
}
async function workerState(cdp: RawCdp, target: Record<string, unknown>): Promise<WorkerReading> {
  const attached = await cdp.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  })
  assert(typeof attached.sessionId === 'string')
  try {
    const heap = await cdp.send('Runtime.getHeapUsage', {}, attached.sessionId)
    const reading = await cdp.send(
      'Runtime.evaluate',
      {
        expression:
          '({terminal:globalThis.__revisionRuntime?.initialize.terminal,submitted:globalThis.__revisionRuntime?.renderer?.metrics?.submittedFrames,ordinal:Number(new URL(location.href).searchParams.get("ordinal"))})',
        returnByValue: true,
      },
      attached.sessionId,
    )
    const value = object(object(reading.result).value)
    assert(typeof target.targetId === 'string' && typeof value.terminal === 'string')
    return {
      target: target.targetId,
      terminal: value.terminal,
      ordinal: numeric(value.ordinal),
      submitted: typeof value.submitted === 'number' ? numeric(value.submitted) : null,
      heap: numeric(heap.usedSize),
    }
  } finally {
    await cdp.send('Target.detachFromTarget', { sessionId: attached.sessionId })
  }
}
async function processes(cdp: CDPSession): Promise<number[]> {
  const result = await cdp.send('SystemInfo.getProcessInfo')
  const ids = result.processInfo.map((process) => process.id)
  assert(ids.length > 0 && new Set(ids).size === ids.length)
  return ids
}
async function threads(pids: number[]) {
  const result: Sample['workerThreads'] = []
  for (const pid of pids) result.push(...(await processThreads(pid)))
  return result
}
async function processThreads(pid: number): Promise<Sample['workerThreads']> {
  const result: Sample['workerThreads'] = []
  for (const entry of await readdir(`/proc/${pid}/task`)) {
    const tid = Number(entry)
    const stat = await readFile(`/proc/${pid}/task/${tid}/stat`, 'utf8')
    const end = stat.lastIndexOf(')')
    const name = stat.slice(stat.indexOf('(') + 1, end)
    if (!name.includes('DedicatedWorker')) continue
    const fields = stat.slice(end + 2).split(' ')
    result.push({
      pid,
      tid,
      start: numeric(Number(fields[19])),
      ticks: numeric(Number(fields[11])) + numeric(Number(fields[12])),
    })
  }
  return result
}
function workerCpu(before: Sample['workerThreads'], after: Sample['workerThreads'], count: number) {
  assert.equal(before.length, count, 'warm DedicatedWorker thread coverage')
  assert.equal(after.length, count, 'measured DedicatedWorker thread coverage')
  return after.reduce((total, next) => {
    const prior = before.find(
      (value) => value.pid === next.pid && value.tid === next.tid && value.start === next.start,
    )
    assert(prior, 'worker thread changed during sample')
    assert(next.ticks >= prior.ticks, 'worker tick counter regressed')
    return total + (next.ticks - prior.ticks) / 100
  }, 0)
}
async function processMemory(pids: number[]): Promise<Sample['processes']> {
  return Promise.all(
    pids.map(async (pid) => {
      const text = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8')
      const match = /^Pss:\s+(\d+)/mu.exec(text)
      assert(match, `PSS unavailable for live process ${pid}`)
      return { pid, pssKiB: numeric(Number(match[1])) }
    }),
  )
}
function freeVram(): number {
  const result = Bun.spawnSync([
    'nvidia-smi',
    '--query-gpu=memory.free',
    '--format=csv,noheader,nounits',
  ])
  assert.equal(result.exitCode, 0, 'nvidia-smi endpoint unavailable')
  return numeric(Number(result.stdout.toString().trim()))
}
async function route(page: Page, assets: Map<string, string | Buffer>) {
  await page.route(`${origin}/**`, async (request) => {
    const pathname = new URL(request.request().url()).pathname
    const body = assets.get(pathname)
    if (!body) return request.abort()
    const extension = pathname.split('.').at(-1)
    const contentTypes: Record<string, string> = {
      wasm: 'application/wasm',
      woff2: 'font/woff2',
      js: 'text/javascript',
      json: 'application/json',
    }
    const contentType = contentTypes[extension ?? ''] ?? 'text/html'
    await request.fulfill({ body, contentType })
  })
}
function quantile(samples: number[], fraction: number) {
  assert(samples.length > 0 && samples.every(Number.isFinite))
  const sorted = samples.toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!
}
async function browserResources() {
  assert.equal(process.platform, 'linux', 'original PC endpoints require Linux')
  if (!headless)
    assert(
      process.env.DISPLAY || process.env.WAYLAND_DISPLAY,
      'unqualified setup: no headed display endpoint',
    )
  const freeMiB = freeVram()
  if (!headless) assert(freeMiB >= 2048, 'unqualified setup: less than 2 GiB free VRAM')
  const args = [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    `--remote-debugging-port=${port}`,
  ]
  if (headless) args.push(...swiftShaderArgs)
  if (!headless && process.env.WAYLAND_DISPLAY) args.push('--ozone-platform=wayland')
  const executablePath = headless ? undefined : '/usr/bin/chromium'
  if (!headless)
    args.push(
      '--enable-automation',
      '--ozone-platform=x11',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-webgpu',
      '--use-angle=vulkan',
      '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan',
      '--disable-vulkan-surface',
    )
  const browser = await chromium.launch({
    executablePath,
    headless,

    args,
    env: headless ? swiftShaderEnv() : undefined,
  })
  let raw: RawCdp | undefined
  try {
    raw = await RawCdp.connect()
    const browserCdp = await browser.newBrowserCDPSession()
    const gpu = await browserCdp.send('SystemInfo.getInfo')
    const renderer =
      typeof gpu.gpu.auxAttributes?.glRenderer === 'string'
        ? gpu.gpu.auxAttributes.glRenderer
        : null
    if (!headless)
      assert(
        renderer && !/swiftshader|llvmpipe|software|lavapipe/iu.test(renderer),
        'unqualified setup: non-software renderer not proved',
      )
    const commandLine = await browserCdp.send('Browser.getBrowserCommandLine')
    const proofPage = await browser.newPage()
    let result: Awaited<ReturnType<typeof probePage>>
    try {
      await proofPage.route(`${origin}/**`, (route) =>
        route.fulfill({
          body: '<!doctype html><title>007 GPU controls</title>',
          contentType: 'text/html',
        }),
      )
      await proofPage.goto(origin)
      result = await proofPage.evaluate(probePage)
    } finally {
      await proofPage.close()
    }
    const hardware = { headless, commandLine, system: gpu, result }
    if (!headless)
      assert(
        Object.values(qualifyHardware(hardware)).every(Boolean),
        'unqualified setup: physical adapter/readback controls failed',
      )
    await Bun.write(
      join(dirname(output), `hardware-${randomUUID()}.json`),
      JSON.stringify({
        hardware,
        executablePath,
        requestedArgs: args,
        browser: browser.version(),
        display: process.env.DISPLAY,
      }),
    )
    return {
      browser,
      raw,
      browserCdp,
      renderer,
      freeMiB,
      hardware,
      executablePath,
      session: randomUUID(),
    }
  } catch (cause) {
    raw?.close()
    await browser.close()
    throw cause
  }
}
async function measure(
  resources: Awaited<ReturnType<typeof browserResources>>,
  mode: Sample['mode'],
  fixture: string,
  count: number,
  columns: number,
  rows: number,
  repetition: number,
  assets: Map<string, string | Buffer>,
): Promise<Sample> {
  const { browser, raw, browserCdp } = resources
  const page = await browser.newPage({
    viewport: { width: 2400, height: 1800 },
    deviceScaleFactor: 2,
  })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    await route(page, assets)
    await page.goto(`${origin}/?fixture=${fixture}&mode=${mode}&parity=${Number(parity)}`)
    await bounded(
      page.evaluate(
        ({ mode, count, columns, rows }) =>
          window.__workerRevisionBench.setup(mode, count, columns, rows),
        { mode, count, columns, rows },
      ),
    )
    await bounded(page.evaluate(() => window.__workerRevisionBench.sample(8)))
    const warm = await page.evaluate(() => window.__workerRevisionBench.report())
    const warmWorkers = await workerStates(raw)
    assert.equal(warmWorkers.length, count)
    const pageCdp = await page.context().newCDPSession(page)
    await pageCdp.send('Performance.enable', { timeDomain: 'threadTicks' })
    const beforeThreads = await threads(await processes(browserCdp))
    await raw.startTrace()
    const clockSync = { id: randomUUID(), beforeEpoch: Date.now(), afterEpoch: 0 }
    await raw.send('Tracing.recordClockSyncMarker', { syncId: clockSync.id })
    clockSync.afterEpoch = Date.now()
    const before = await pageCdp.send('Performance.getMetrics')
    await bounded(page.evaluate((steps) => window.__workerRevisionBench.sample(steps), steps))
    const after = await pageCdp.send('Performance.getMetrics')
    await raw.endTrace()
    const pids = await processes(browserCdp)
    const afterThreads = await threads(pids)
    const workerSeconds = workerCpu(beforeThreads, afterThreads, count)
    const memory = await processMemory(pids)
    const report = await page.evaluate(() => window.__workerRevisionBench.report())
    const workers = await workerStates(raw)
    assert.equal(workers.length, count)
    assert(
      workers.every(
        (worker, ordinal) =>
          worker.ordinal === ordinal &&
          worker.terminal === warmWorkers[ordinal]?.terminal &&
          worker.target === warmWorkers[ordinal]?.target,
      ),
    )
    const submittedCounts = workers.every(
      (worker, ordinal) => worker.submitted !== null && warmWorkers[ordinal]?.submitted !== null,
    )
      ? workers.map((worker, ordinal) => worker.submitted! - warmWorkers[ordinal]!.submitted!)
      : null
    const snapshots = await page.evaluate(() => window.__workerRevisionBench.snapshotReport())
    const deliveredFrames = report.deliveredFrames.map(
      (value, index) => value - warm.deliveredFrames[index]!,
    )
    const metric = (metrics: typeof before, name: string) => {
      const value = metrics.metrics.find((entry) => entry.name === name)
      assert(value, `missing ${name}`)
      return numeric(value.value)
    }
    const host =
      (1000 * (metric(after, 'TaskDuration') - metric(before, 'TaskDuration'))) /
      deliveredFrames.reduce((sum, n) => sum + n, 0)
    const gpuDelta = Math.max(0, resources.freeMiB - freeVram())
    const contract = parity
      ? await bounded(page.evaluate(() => window.__workerRevisionBench.contractProbe()))
      : null
    const prefix = `${fixture}-${mode}-${count}-${columns}x${rows}-${repetition}`
    const screenshots: string[] = []
    for (let ordinal = 0; ordinal < count; ordinal += 1) {
      const png = await page
        .locator('canvas')
        .nth(ordinal)
        .screenshot({ path: join(dirname(output), `${prefix}-${ordinal}.png`) })
      screenshots.push(await pixelHash(page, png))
    }
    const receipt: Sample = {
      mode,
      fixture,
      count,
      columns,
      rows,
      repetition,
      browserSession: resources.session,
      browser: browser.version(),
      headless,
      renderer: resources.renderer,
      hardware: resources.hardware,
      executablePath: resources.executablePath,
      expectedProcesses: pids,
      freeMiB: resources.freeMiB,
      warmup,
      steps,
      host,
      workerCpu: workerSeconds,
      resident: memory.reduce((sum, process) => sum + process.pssKiB / 1024, 0) + gpuDelta,
      p95: quantile(report.acknowledgements.slice(warm.acknowledgements.length), 0.95),
      p99: quantile(report.acknowledgements.slice(warm.acknowledgements.length), 0.99),
      acknowledgementCount: report.acknowledgements.length - warm.acknowledgements.length,
      workers,
      workerThreads: afterThreads,
      processes: memory,
      submittedCounts,
      parsedCounts: report.writeCounts.map((value, index) => value - warm.writeCounts[index]!),
      deliveredFrames,
      presentedCounts: null,
      inputHashes: report.inputs.map((chunks) => sha(JSON.stringify(chunks))),
      inputBytes: report.inputs.map((chunks) =>
        chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk), 0),
      ),
      eventHashes: report.events.map((events) => sha(JSON.stringify(events))),
      rowHashes: report.rows.map((rows) => sha(JSON.stringify(rows))),
      snapshotHashes: snapshots.map((snapshot, index) =>
        sha(JSON.stringify({ snapshot, contract: index === 0 ? contract : undefined })),
      ),
      screenshots,
      frameSequences: report.frameSequences,
      errors: errors.concat(report.errors),
    }
    await Bun.write(
      join(dirname(output), `${prefix}-joins.json`),
      JSON.stringify({
        contract,
        snapshots,
        timings: report.timings.slice(warm.timings.length),
        clockSync,
        gc: raw.trace.filter((event) =>
          /GC|Scaveng|Mark|Minor|Major|clock_sync|thread_name/iu.test(String(event.name)),
        ),
        workerCpuBefore: beforeThreads,
        workerCpuAfter: afterThreads,
        hostHandlerMilliseconds: report.hostHandlerMilliseconds - warm.hostHandlerMilliseconds,
        pids,
        gpuDelta,
      }),
    )
    return receipt
  } finally {
    await bounded(page.evaluate(() => window.__workerRevisionBench?.dispose())).catch(() => {})
    await page.close()
  }
}
async function pixelHash(page: Page, png: Buffer): Promise<string> {
  return page.evaluate(async (encoded) => {
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('pixel comparison context unavailable')
    context.drawImage(bitmap, 0, 0)
    bitmap.close()
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data
    const digest = await crypto.subtle.digest('SHA-256', data)
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  }, png.toString('base64'))
}

async function assets(arm: string) {
  const result = new Map<string, string | Buffer>([
    [
      '/',
      '<!doctype html><style>body{margin:0;background:#000}main{display:flex;flex-direction:column;gap:4px}canvas{max-width:none}</style><main></main><script type="module" src="/page.js"></script>',
    ],
    ['/page.js', await bundle(arm, false)],
    ['/worker.js', await bundle(arm, true)],
    ['/ghostty-vt.wasm', await readFile(join(arm, 'ghostty-vt.wasm'))],
    ['/bridge.wasm', await readFile(join(arm, 'bridge.wasm'))],
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
  for (const fixture of fixtures) {
    if (fixture === 'mixed-edit') continue
    result.set(`/fixtures/${fixture}.json`, await fixtureChunks(fixture))
  }
  return result
}
async function fixtureChunks(fixture: string) {
  const directory = process.env.WORKER_REVISION_FIXTURE_DIR
  assert(directory, 'WORKER_REVISION_FIXTURE_DIR is required')
  const metadata = object(JSON.parse(await readFile(join(directory, `${fixture}.json`), 'utf8')))
  const bytes = await readFile(join(directory, `${fixture}.bin`))
  const expected: Record<string, string> = {
    'sustained-logs': '4cafe65ef01bc8735632f483952f12ef58211ee15fdf6495df148d532db297d9',
    'unicode-varied': 'dc1604315d3e0a98d5549d126364baa74f4ea34335a55aff1bfacc4802c83c23',
  }
  assert.equal(sha(bytes), expected[fixture], 'original fixture bytes required')
  assert.equal(sha(bytes), metadata.sha256)
  assert(Array.isArray(metadata.chunks))
  return JSON.stringify(
    metadata.chunks.map((entry) => {
      const chunk = object(entry)
      const offset = numeric(chunk.offset)
      const length = numeric(chunk.length)
      return bytes.subarray(offset, offset + length).toString('utf8')
    }),
  )
}
async function main() {
  await mkdir(dirname(output), { recursive: true })
  const source = await provenance()
  const built = { control: await assets(control!), candidate: await assets(root) }
  const packet: ResearchReceipt = {
    ...source,
    headless,
    parity,
    repetitions,
    warmup,
    steps,
    cohort: fixtures.includes('mixed-edit') ? 'full' : 'screen',
    endpoints: endpointNames,
    results: [],
  }
  try {
    for (let repetition = 0; repetition < repetitions; repetition += 1)
      await runRepetition(repetition, built, packet)
  } finally {
    await Bun.write(output, JSON.stringify(packet, null, 2) + '\n')
    await Bun.write(
      output.replace(/\.json$/u, '') + '-summary.json',
      JSON.stringify(analyze(packet), null, 2) + '\n',
    )
  }
}
async function runRepetition(
  repetition: number,
  built: Record<Sample['mode'], Map<string, string | Buffer>>,
  packet: ResearchReceipt,
) {
  const cases = geometries.flatMap((grid) =>
    counts.flatMap((count) => fixtures.map((fixture) => ({ ...grid, count, fixture }))),
  )
  for (const condition of cases) {
    const resources = await browserResources()
    try {
      await runPair(repetition, condition, resources, built, packet)
    } finally {
      resources.raw.close()
      await resources.browser.close()
    }
  }
}
async function runPair(
  repetition: number,
  condition: { columns: number; rows: number; count: number; fixture: string },
  resources: Awaited<ReturnType<typeof browserResources>>,
  built: Record<Sample['mode'], Map<string, string | Buffer>>,
  packet: ResearchReceipt,
) {
  const order: Sample['mode'][] =
    repetition % 2 === 0 ? ['control', 'candidate'] : ['candidate', 'control']
  for (const mode of order) {
    console.log(
      `sample ${condition.fixture} ${mode} ${condition.count} ${condition.columns}x${condition.rows} repetition ${repetition}`,
    )
    const result = await measure(
      resources,
      mode,
      condition.fixture,
      condition.count,
      condition.columns,
      condition.rows,
      repetition,
      built[mode],
    )
    packet.results.push(result)
    await Bun.write(output, JSON.stringify(packet, null, 2) + '\n')
  }
  const pair = packet.results.slice(-2)
  for (const field of [
    'inputHashes',
    'inputBytes',
    'eventHashes',
    'rowHashes',
    'snapshotHashes',
    'screenshots',
    'parsedCounts',
    'deliveredFrames',
    'frameSequences',
  ] as const)
    assert.deepEqual(pair[0]![field], pair[1]![field], `${field} parity`)
  // Independent submission differences are findings, not an added equality gate.
  if (JSON.stringify(pair[0]!.submittedCounts) !== JSON.stringify(pair[1]!.submittedCounts))
    console.warn(
      'independent submission counts differ',
      pair.map((run) => run.submittedCounts),
    )
}
const scratch = await mkdtemp('/work/tmp/g007-')
process.env.TMPDIR = scratch
process.env.TMP = scratch
process.env.TEMP = scratch
try {
  await main()
} finally {
  await rm(scratch, { recursive: true, force: true })
}

async function probePage() {
  function canvas() {
    const value = document.createElement('canvas')
    value.width = 8
    value.height = 8
    document.body.append(value)
    return value
  }
  function glProbe(kind: 'webgl' | 'webgl2') {
    const gl = canvas().getContext(kind, { preserveDrawingBuffer: true, antialias: false })
    if (!(gl instanceof WebGLRenderingContext || gl instanceof WebGL2RenderingContext))
      return { kind, available: false } satisfies { kind: string; available: false }
    const debug = gl.getExtension('WEBGL_debug_renderer_info')
    const vertex = gl.createShader(gl.VERTEX_SHADER)
    const fragment = gl.createShader(gl.FRAGMENT_SHADER)
    const program = gl.createProgram()
    if (!vertex || !fragment || !program) throw new Error('GL resource creation failed')
    gl.shaderSource(vertex, 'attribute vec2 p; void main(){gl_Position=vec4(p,0.,1.);}')
    gl.shaderSource(
      fragment,
      'precision mediump float; void main(){gl_FragColor=vec4(1.,0.,0.,1.);}',
    )
    gl.compileShader(vertex)
    gl.compileShader(fragment)
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(String(gl.getProgramInfoLog(program)))
    gl.useProgram(program)
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 0, 1]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, 'p')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    const center = new Uint8Array(4)
    const corner = new Uint8Array(4)
    gl.readPixels(4, 3, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, center)
    gl.readPixels(0, 7, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, corner)
    const result = {
      kind,
      available: true as const,
      vendor: String(gl.getParameter(gl.VENDOR)),
      renderer: String(gl.getParameter(gl.RENDERER)),
      unmaskedVendor: debug && String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)),
      unmaskedRenderer: debug && String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)),
      version: String(gl.getParameter(gl.VERSION)),
      center: Array.from(center),
      corner: Array.from(corner),
      error: gl.getError(),
      positiveControl: center.join() === '255,0,0,255' && corner.join() === '0,0,0,255',
    }
    gl.deleteBuffer(buffer)
    gl.deleteProgram(program)
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return result
  }
  async function gpuProbe() {
    if (!navigator.gpu) return { available: false as const, reason: 'navigator.gpu absent' }
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) return { available: false as const, reason: 'requestAdapter returned null' }
    const info = adapter.info
    const identity = {
      vendor: info.vendor,
      architecture: info.architecture,
      device: info.device,
      description: info.description,
      isFallbackAdapter: info.isFallbackAdapter,
    }
    const device = await adapter.requestDevice()
    const errors: string[] = []
    device.addEventListener('uncapturederror', (event) => errors.push(event.error.message))
    device.pushErrorScope('validation')
    const target = canvas()
    const context = target.getContext('webgpu')
    if (!context) throw new Error('WebGPU canvas context absent')
    const format = navigator.gpu.getPreferredCanvasFormat()
    context.configure({
      device,
      format,
      alphaMode: 'opaque',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    })
    const shader = device.createShaderModule({
      code: `
      @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
        let p = array<vec2f,3>(vec2f(-1,-1), vec2f(1,-1), vec2f(0,1));
        return vec4f(p[i],0,1);
      }
      @fragment fn fs() -> @location(0) vec4f { return vec4f(1,0,0,1); }
    `,
    })
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: shader, entryPoint: 'vs' },
      fragment: { module: shader, entryPoint: 'fs', targets: [{ format }] },
    })
    const texture = context.getCurrentTexture()
    const readback = device.createBuffer({
      size: 256 * 8,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    const encoder = device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
      ],
    })
    pass.setPipeline(pipeline)
    pass.draw(3)
    pass.end()
    encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow: 256 }, [8, 8])
    device.queue.submit([encoder.finish()])
    await readback.mapAsync(GPUMapMode.READ)
    const pixels = new Uint8Array(readback.getMappedRange())
    const center = Array.from(pixels.subarray(4 * 256 + 4 * 4, 4 * 256 + 4 * 4 + 4))
    const corner = Array.from(pixels.subarray(0, 4))
    const expected = format.startsWith('bgra') ? '0,0,255,255' : '255,0,0,255'
    const validation = await device.popErrorScope()
    const result = {
      available: true as const,
      identity,
      format,
      center,
      corner,
      errors,
      validation: validation?.message ?? null,
      positiveControl:
        center.join() === expected &&
        corner.join() === '0,0,0,255' &&
        !validation &&
        errors.length === 0,
    }
    readback.unmap()
    readback.destroy()
    context.unconfigure()
    device.destroy()
    return result
  }
  function safeGlProbe(kind: 'webgl' | 'webgl2') {
    try {
      return glProbe(kind)
    } catch (error) {
      return { available: false as const, reason: String(error) }
    }
  }
  const webgl = safeGlProbe('webgl')
  const webgl2 = safeGlProbe('webgl2')
  let webgpu
  try {
    webgpu = await gpuProbe()
  } catch (error) {
    webgpu = { available: false as const, reason: String(error) }
  }
  return {
    secureContext: isSecureContext,
    userAgent: navigator.userAgent,
    visibility: document.visibilityState,
    webgl,
    webgl2,
    webgpu,
  }
}

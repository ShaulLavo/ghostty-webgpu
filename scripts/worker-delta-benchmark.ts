import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { chromium, type CDPSession, type Page } from 'playwright'
import { createCounterReader } from './comparison-counters.mjs'

const root = join(import.meta.dirname, '..')
const output = resolve(
  process.env.WORKER_DELTA_OUTPUT ?? join(root, '.artifacts/worker-delta.json'),
)
const steps = Number(process.env.WORKER_DELTA_STEPS ?? 60)
const repetitions = Number(process.env.WORKER_DELTA_REPETITIONS ?? 2)
const headless = process.env.WORKER_DELTA_HEADLESS === '1'
const backend =
  process.env.WORKER_DELTA_BACKEND ?? (process.platform === 'darwin' ? 'webgpu' : 'webgl')
const origin = 'http://localhost:41917'
const port = 41918
const fixtures = process.env.WORKER_DELTA_FIXTURES?.split(',') ?? [
  'mixed-edit',
  'sustained-logs',
  'unicode-varied',
]
const modes = ['control', 'delta'] as const
const counts = process.env.WORKER_DELTA_COUNTS?.split(',').map(Number) ?? [4, 16]
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

async function bundle(entrypoint: string, binary = false): Promise<string> {
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
              experimentReception.receive(data, (message) => this.receive(message))
              if (data.type === 'frame') window.__workerReceiveMilliseconds += performance.now() - started
            }`
            assert(source.includes(before), 'worker timing patch no longer matches')
            const prefix = `import { Reception } from '${join(root, '.internal/worker-delta-prototype/transport.ts')}'
            const experimentReception = new Reception(new URL(location.href).searchParams.get('mode') === 'delta')\n`
            return { contents: prefix + source.replace(before, after), loader: 'ts' }
          })
          build.onLoad({ filter: /src\/dom\/execution-local\.ts$/u }, async ({ path }) => {
            const source = await readFile(path, 'utf8')
            const before =
              'get canPaint() {\n        return execution.rendererValue?.canPaint\n      },'
            const after = `${before}\n      get metrics() {\n        return execution.rendererValue?.metrics\n      },`
            assert(source.includes(before), 'renderer metrics patch no longer matches')
            return { contents: source.replace(before, after), loader: 'ts' }
          })
          build.onLoad({ filter: /src\/worker\/structured-errors\.ts$/u }, async ({ path }) => {
            const source = await readFile(path, 'utf8')
            const before = 'causeType: cause instanceof Error ? cause.name : typeof cause,'
            const after = `${before}\n      causeStack: cause instanceof Error ? cause.stack : undefined,`
            assert(source.includes(before), 'error patch no longer matches')
            return { contents: source.replace(before, after), loader: 'ts' }
          })
          build.onLoad({ filter: /src\/core\/displayed-frame\.ts$/u }, async ({ path }) => {
            let source = await readFile(path, 'utf8')
            const changes = [
              [
                '  private readRevisions(slot: NativeSlot): number[] {',
                '  revisionList(slot: NativeSlot): readonly number[] {\n    return this.slotRevisions.get(slot) ?? this.readRevisions(slot)\n  }\n\n  private readRevisions(slot: NativeSlot): number[] {',
              ],
              [
                '  readTextRows(options: DisplayedTextOptions = noOptions): readonly RenderTextRow[] {',
                '  readTextRevisions(): readonly number[] {\n    this.active()\n    return this.frames.textCache.revisionList(this.current)\n  }\n\n  readTextRows(options: DisplayedTextOptions = noOptions): readonly RenderTextRow[] {',
              ],
            ]
            for (const [before, after] of changes) {
              assert(
                before && after && source.includes(before),
                'displayed-frame patch no longer matches',
              )
              source = source.replace(before, after)
            }
            return { contents: source, loader: 'ts' }
          })
          build.onLoad({ filter: /src\/worker\/runtime\.ts$/u }, async ({ path }) => {
            let source = await readFile(path, 'utf8')
            const changes = [
              [
                'async start(): Promise<void> {',
                'async start(): Promise<void> {\n    globalThis.__deltaIdentity = this.initialize.terminal\n    globalThis.__deltaSubmitted = 0',
              ],
              [
                'const request = event.data',
                "const request = event.data\n    if (request.type === 'request') experimentPublication.queue(request)",
              ],
              [
                'private async execute(request: WorkerRequest): Promise<void> {',
                'private async execute(request: WorkerRequest): Promise<void> {\n    experimentPublication.execute(request)',
              ],
              [
                "private submitFrame(snapshot: Parameters<LocalTerminalExecution['submit']>[0]): void {",
                "private submitFrame(snapshot: Parameters<LocalTerminalExecution['submit']>[0]): void {\n    globalThis.__deltaSubmitted = (this.renderer as unknown as {metrics?: {submittedFrames: number}} | undefined)?.metrics?.submittedFrames ?? 0",
              ],
              [
                'const device = await adapter.requestDevice()',
                'globalThis.__deltaAdapter = {fallback: adapter.isFallbackAdapter, info: adapter.info}\n      const device = await adapter.requestDevice()',
              ],
              [
                'this.initialize.port.postMessage(message)',
                'experimentPublication.post(this.initialize.port, message)',
              ],
            ]
            for (const [before, after] of changes) {
              assert(before && after && source.includes(before), 'runtime patch no longer matches')
              source = source.replace(before, after)
            }
            if (binary) {
              const retained = [
                [
                  'needsFrameRows: () => true,',
                  'needsFrameRows: () => true,\n      retainDisplayedText: true,',
                ],
                [
                  "onTextFrame: (snapshot: Parameters<LocalTerminalExecution['submit']>[0]) =>",
                  "[observeDisplayedFrame]: (snapshot: Parameters<LocalTerminalExecution['submit']>[0]) =>",
                ],
              ]
              for (const [before, after] of retained) {
                assert(
                  before && after && source.includes(before),
                  'retained observer patch no longer matches',
                )
                source = source.replace(before, after)
              }
            }
            const revisionImport = binary
              ? `import { observeDisplayedFrame } from '${join(root, 'src/render/shared/displayed-frame.ts')}'\n`
              : ''
            const prefix = `${revisionImport}import { Publication } from '${join(root, '.internal/worker-delta-prototype/transport.ts')}'
            const experimentPublication = new Publication(${binary}, ${process.env.WORKER_DELTA_PARITY === '1'})\n`
            return { contents: prefix + source, loader: 'ts' }
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

function workerTrace(trace: Record<string, unknown>[]) {
  const workers = new Set<string>()
  for (const event of trace) {
    if (event.ph !== 'M' || event.name !== 'thread_name') continue
    const args = event.args as { name?: string }
    if (args.name?.includes('DedicatedWorker')) workers.add(`${event.pid}:${event.tid}`)
  }
  const taskNames: Record<string, number> = {}
  let seconds = 0
  for (const event of trace) {
    if (!workers.has(`${event.pid}:${event.tid}`) || event.ph !== 'X') continue
    const duration = Number(event.dur ?? 0) / 1_000_000
    const name = String(event.name)
    taskNames[name] = (taskNames[name] ?? 0) + duration
    if (name === 'ThreadControllerImpl::RunTask') seconds += duration
  }
  return { seconds, taskNames, threads: workers.size }
}

async function workerStates(cdp: RawCdp) {
  const targets = await cdp.send('Target.getTargets')
  assert(Array.isArray(targets.targetInfos))
  const states: Record<string, unknown>[] = []
  for (const target of targets.targetInfos) {
    if (target.type !== 'worker') continue
    const attached = await cdp.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    })
    assert(typeof attached.sessionId === 'string')
    const heap = await cdp.send('Runtime.getHeapUsage', {}, attached.sessionId)
    const identity = await cdp.send(
      'Runtime.evaluate',
      {
        expression:
          '({terminal:globalThis.__deltaIdentity,epoch:performance.timeOrigin+performance.now(),submitted:globalThis.__deltaSubmitted,adapter:globalThis.__deltaAdapter,ordinal:Number(new URL(location.href).searchParams.get("ordinal"))})',
        returnByValue: true,
      },
      attached.sessionId,
    )
    states.push({ targetId: target.targetId, url: target.url, identity, ...heap })
    await cdp.send('Target.detachFromTarget', { sessionId: attached.sessionId })
  }
  return states
}

interface WorkerIdentity {
  terminal: string
  ordinal: number
  submitted: number
  adapter?: { fallback: boolean }
}

function workerIdentity(state: Record<string, unknown>): WorkerIdentity {
  const identity = state.identity as { result: { value: WorkerIdentity } }
  return identity.result.value
}

function workerDeltas(
  before: Record<string, unknown>[],
  after: Record<string, unknown>[],
): number[] {
  const prior = new Map(before.map((state) => [workerIdentity(state).terminal, state]))
  const submittedCounts: number[] = []
  const ordered = after.toSorted(
    (left, right) => workerIdentity(left).ordinal - workerIdentity(right).ordinal,
  )
  for (const state of ordered) {
    const identity = workerIdentity(state)
    const previous = prior.get(identity.terminal)
    assert(previous, `missing warm worker ${identity.terminal}`)
    submittedCounts.push(identity.submitted - workerIdentity(previous).submitted)
  }
  return submittedCounts
}

async function processes(
  cdp: CDPSession,
): Promise<{ id: number; type: string; cpuTime: number }[]> {
  const result = await cdp.send('SystemInfo.getProcessInfo')
  return result.processInfo
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

async function macMemory(
  counters: Awaited<ReturnType<typeof createCounterReader>>,
  running: { id: number; type: string; cpuTime: number }[],
) {
  assert(!counters.skipped, counters.reason ?? 'native process counters unavailable')
  const snapshot = (await counters.snapshot(running)) as {
    processes: Record<string, { values: { ri_phys_footprint?: string; error?: unknown } }>
  }
  let bytes = 0n
  for (const process of Object.values(snapshot.processes)) {
    assert(!process.values.error, String(process.values.error))
    const footprint = process.values.ri_phys_footprint
    assert(typeof footprint === 'string', 'physical footprint missing')
    bytes += BigInt(footprint)
  }
  return { totalResidentMiB: Number(bytes) / 1024 / 1024, physicalFootprint: snapshot }
}

async function route(page: Page, assets: Map<string, string | Buffer>): Promise<void> {
  await page.route(`${origin}/**`, async (request) => {
    const pathname = new URL(request.request().url()).pathname
    const body = assets.get(pathname)
    if (!body) return request.abort()
    const types = new Map([
      ['wasm', 'application/wasm'],
      ['woff2', 'font/woff2'],
      ['js', 'text/javascript'],
      ['json', 'application/json'],
    ])
    const contentType = types.get(pathname.split('.').at(-1) ?? '') ?? 'text/html'
    await request.fulfill({ body, contentType })
  })
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

async function bounded<Value>(promise: Promise<Value>): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('X4 browser operation exceeded 60 seconds')),
          60_000,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function browserResources() {
  const args = [
    '--enable-unsafe-webgpu',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    `--remote-debugging-port=${port}`,
  ]
  if (!headless && process.env.WAYLAND_DISPLAY) args.push('--ozone-platform=wayland')
  if (!headless) assert(process.platform === 'darwin', 'timing runs require the M1 Mac')
  const freeMiB =
    process.platform === 'linux'
      ? Number(
          Bun.spawnSync(['nvidia-smi', '--query-gpu=memory.free', '--format=csv,noheader,nounits'])
            .stdout.toString()
            .trim(),
        )
      : 0
  if (!headless && process.platform === 'linux')
    assert(freeMiB >= 2048, `only ${freeMiB} MiB VRAM free`)
  const browser = await chromium.launch({ channel: 'chromium', headless, args })
  let raw: RawCdp | undefined
  let counters: Awaited<ReturnType<typeof createCounterReader>> | undefined
  try {
    raw = await RawCdp.connect()
    const browserCdp = await browser.newBrowserCDPSession()
    if (process.platform === 'darwin') {
      counters = await createCounterReader(browserCdp)
      assert(!counters.skipped, counters.reason ?? 'native process counters unavailable')
    }
    const gpuInfo = await browserCdp.send('SystemInfo.getInfo')
    if (!headless)
      assert(
        typeof gpuInfo.gpu.auxAttributes?.glRenderer === 'string' &&
          !/swiftshader|llvmpipe|software/iu.test(gpuInfo.gpu.auxAttributes.glRenderer),
        'hardware adapter required',
      )
    return { browser, raw, browserCdp, counters, gpuInfo, args, freeMiB, session: randomUUID() }
  } catch (cause) {
    raw?.close()
    await counters?.close?.()
    await browser.close()
    throw cause
  }
}

async function measure(
  resources: Awaited<ReturnType<typeof browserResources>>,
  mode: (typeof modes)[number],
  fixture: string,
  count: number,
  columns: number,
  rows: number,
  repetition: number,
  assets: Map<string, string | Buffer>,
) {
  const { browser, raw, browserCdp, counters, gpuInfo, args, freeMiB, session } = resources
  const page = await browser.newPage({
    viewport: { width: 2400, height: 1800 },
    deviceScaleFactor: 2,
  })
  try {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error')
        pageErrors.push(message.text())
    })
    await route(page, assets)
    await page.goto(`${origin}/?fixture=${fixture}&mode=${mode}&backend=${backend}`)
    await bounded(
      page.evaluate(
        ({ mode, count, columns, rows }) =>
          window.__workerDeltaBench.setup(mode, count, columns, rows),
        { mode, count, columns, rows },
      ),
    )
    const initialWorkers = await workerStates(raw)
    assert.equal(initialWorkers.length, count, 'worker target count')
    if (backend === 'webgpu') {
      for (const state of initialWorkers)
        assert(
          workerIdentity(state).adapter?.fallback === false,
          'hardware WebGPU adapter required',
        )
    }
    const pageCdp = await page.context().newCDPSession(page)
    await pageCdp.send('Performance.enable', { timeDomain: 'threadTicks' })
    await bounded(page.evaluate(() => window.__workerDeltaBench.sample(8)))
    const warm = await bounded(page.evaluate(() => window.__workerDeltaBench.report()))
    const warmWorkers = await workerStates(raw)
    await raw.startTrace()
    const clockSync = { id: randomUUID(), beforeEpoch: Date.now(), afterEpoch: 0 }
    await raw.send('Tracing.recordClockSyncMarker', { syncId: clockSync.id })
    clockSync.afterEpoch = Date.now()
    const before = await processes(browserCdp)
    const beforeMetrics = await pageCdp.send('Performance.getMetrics')
    const started = performance.now()
    await bounded(page.evaluate((count) => window.__workerDeltaBench.sample(count), steps))
    const elapsed = performance.now() - started
    const afterMetrics = await pageCdp.send('Performance.getMetrics')
    await raw.endTrace()
    const workerTiming = workerTrace(raw.trace)
    assert(workerTiming.threads > 0, 'dedicated-worker trace threads missing')
    assert(workerTiming.seconds > 0, 'dedicated-worker task duration missing')
    const after = await processes(browserCdp)
    const report = await bounded(page.evaluate(() => window.__workerDeltaBench.report()))
    const liveWorkers = await workerStates(raw)
    const submittedCounts = workerDeltas(warmWorkers, liveWorkers)
    const pageHeap = await pageCdp.send('Runtime.getHeapUsage')
    const hostMemory =
      process.platform === 'linux'
        ? await processMemory(after.map((process) => process.id))
        : { pssKiB: 0, rssKiB: 0 }
    const sampleFreeMiB =
      process.platform === 'linux'
        ? Number(
            Bun.spawnSync([
              'nvidia-smi',
              '--query-gpu=memory.free',
              '--format=csv,noheader,nounits',
            ])
              .stdout.toString()
              .trim(),
          )
        : 0
    const memory = counters
      ? await macMemory(counters, after)
      : {
          ...hostMemory,
          gpuDeltaMiB: freeMiB - sampleFreeMiB,
          totalResidentMiB: hostMemory.pssKiB / 1024 + Math.max(0, freeMiB - sampleFreeMiB),
        }
    const snapshots = await bounded(page.evaluate(() => window.__workerDeltaBench.snapshotReport()))
    const prefix = `${fixture}-${mode}-${count}-${columns}x${rows}-${repetition}`
    const screenshots: string[] = []
    for (let index = 0; index < count; index += 1) {
      const png = await page
        .locator('canvas')
        .nth(index)
        .screenshot({ path: join(dirname(output), `${prefix}-${index}.png`) })
      screenshots.push(await pixelHash(page, png))
    }
    const metric = (name: string) =>
      (afterMetrics.metrics.find((metric) => metric.name === name)?.value ?? 0) -
      (beforeMetrics.metrics.find((metric) => metric.name === name)?.value ?? 0)
    const delivered = report.deliveredFrames.map(
      (value, index) => value - warm.deliveredFrames[index]!,
    )
    const receipt = {
      mode,
      backend,
      fixture,
      count,
      columns,
      rows,
      repetition,
      steps,
      elapsedMilliseconds: elapsed,
      browserSession: session,
      browser: browser.version(),
      gpuInfo,
      args,
      freeMiB,
      pageErrors,
      cpu: {
        workerSeconds: workerTiming.seconds,
        workerCpuBasis: 'top-level task duration on dedicated-worker trace threads',
        hostTaskSeconds: metric('TaskDuration'),
        hostScriptSeconds: metric('ScriptDuration'),
        before,
        after,
      },
      pageHeap,
      workerHeaps: liveWorkers,
      workerTrace: workerTiming,
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
      timings: report.timings.slice(warm.timings.length),
      gc: {
        clockSync,
        events: raw.trace.filter((event) =>
          /GC|Scaveng|Mark|Minor|Major|clock_sync|thread_name/iu.test(String(event.name)),
        ),
      },
      eventHashes: report.events.map((events) =>
        createHash('sha256').update(JSON.stringify(events)).digest('hex'),
      ),
      inputHashes: report.inputs.map((chunks) =>
        createHash('sha256').update(JSON.stringify(chunks)).digest('hex'),
      ),
      inputBytes: report.inputs.map((chunks) =>
        chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk), 0),
      ),
      parsedCounts: report.writeCounts.map((value, index) => value - warm.writeCounts[index]!),
      submittedCounts,
      submissionCountBasis: 'renderer metrics read through each worker CDP target',
      presentedCounts: null,
      snapshotHashes: snapshots.map((snapshot) =>
        createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
      ),
      snapshots,
    }
    await bounded(page.evaluate(() => window.__workerDeltaBench.dispose()))
    return receipt
  } finally {
    await page.close()
  }
}

async function main(): Promise<void> {
  await mkdir(dirname(output), { recursive: true })
  const assets = new Map<string, string | Buffer>([
    [
      '/',
      '<!doctype html><style>body{margin:0;background:#000}main{display:flex;flex-direction:column;gap:4px}canvas{max-width:none}</style><main></main><script type="module" src="/page.js"></script>',
    ],
    ['/page.js', await bundle('bench/worker-delta-page.ts')],
    ['/delta-worker.js', await bundle('src/worker/entry.ts', true)],
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
  for (const fixture of fixtures) await addFixture(fixture)
  async function addFixture(fixture: string): Promise<void> {
    if (fixture === 'mixed-edit') return
    const directory =
      process.env.WORKER_DELTA_FIXTURE_DIR ??
      '/work/reports/ghostty-webgpu-reference-study-2026-10-27/bench/workloads'
    const metadata = JSON.parse(await readFile(join(directory, `${fixture}.json`), 'utf8'))
    const bytes = await readFile(join(directory, `${fixture}.bin`))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata.sha256)
    const chunks = metadata.chunks.map((chunk: { offset: number; length: number }) =>
      bytes.subarray(chunk.offset, chunk.offset + chunk.length).toString('utf8'),
    )
    assets.set(`/fixtures/${fixture}.json`, JSON.stringify(chunks))
  }
  const results: Awaited<ReturnType<typeof measure>>[] = []
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
    const cases = geometries.flatMap((geometry) =>
      counts.flatMap((count) => fixtures.map((fixture) => ({ geometry, count, fixture }))),
    )
    for (const sample of cases) await runPair(sample, repetition, order)
  }
  async function runPair(
    sample: { geometry: (typeof geometries)[number]; count: number; fixture: string },
    repetition: number,
    order: readonly (typeof modes)[number][],
  ) {
    const resources = await browserResources()
    try {
      for (const mode of order) {
        const { geometry, count, fixture } = sample
        console.log(
          `sample ${fixture} ${mode} ${count} ${geometry.columns}x${geometry.rows} r${repetition}`,
        )
        const result = await measure(
          resources,
          mode,
          fixture,
          count,
          geometry.columns,
          geometry.rows,
          repetition,
          assets,
        )
        results.push(result)
        await Bun.write(output, JSON.stringify({ results }, null, 2))
      }
      const pair = results.slice(-2)
      assert.deepEqual(
        pair[0]?.eventHashes,
        pair[1]?.eventHashes,
        'native event contents and order',
      )
      assert.deepEqual(pair[0]?.inputHashes, pair[1]?.inputHashes, 'input bytes and order')
      assert.deepEqual(pair[0]?.inputBytes, pair[1]?.inputBytes, 'input byte counts')
      assert.deepEqual(pair[0]?.rowHashes, pair[1]?.rowHashes, 'text parity')
      assert.deepEqual(pair[0]?.screenshots, pair[1]?.screenshots, 'pixel parity')
      assert.deepEqual(pair[0]?.snapshotHashes, pair[1]?.snapshotHashes, 'complete snapshot parity')
      assert.deepEqual(pair[0]?.deliveredFrames, pair[1]?.deliveredFrames, 'delivery parity')
      assert.deepEqual(pair[0]?.submittedCounts, pair[1]?.submittedCounts, 'submission parity')
    } finally {
      resources.raw.close()
      await resources.counters?.close?.()
      await resources.browser.close()
    }
  }
}
const scratchBase = process.platform === 'darwin' ? join(process.env.HOME!, 'tmp') : '/work/tmp'
await mkdir(scratchBase, { recursive: true })
const scratch = await mkdtemp(join(scratchBase, 'x4r-'))
process.env.TMPDIR = scratch
try {
  await main()
} finally {
  await rm(scratch, { recursive: true, force: true })
}

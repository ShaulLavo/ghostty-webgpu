import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { platform, release, arch, cpus } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import {
  ComparisonDeadlineError,
  measureCpu,
  verifyHash,
  withDeadline,
} from './comparison-guards.mjs'
import {
  positiveInteger,
  selection,
  hardwareLaunch,
  frameBuilders,
  selectedVariants,
  selectedPhases,
  measurementCases,
  measurementRepetitions,
} from './comparison-options.mjs'
import { presentationLatency } from './comparison-latency.mjs'
import { comparisonLatencyEndpoint } from './comparison-compact.mjs'
import { createGpuGate } from './comparison-gpu.mjs'
import { ink } from './comparison-pixels.mjs'
import {
  assertDisplay,
  discardTraceWindow,
  displayProbe,
  fitGrid,
  fitWindow,
  prepareOutput,
  tracePhase,
} from './comparison-trace.mjs'
import { WebSocketServer } from 'ws'
import { markdown, summaries } from './comparison-report.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
const args = process.argv.slice(2)
const smoke = args.includes('--smoke')
const tracing = args.includes('--trace')
const builders = frameBuilders(args)
const phases = selectedPhases(args)
assert(!(tracing && args.includes('--phases')), '--trace uses --trace-phase')
assert(
  !args.includes('--validate-presentation') || phases.includes('latency'),
  '--validate-presentation requires the latency phase',
)
assert(!(smoke && tracing), 'Trace measurements require hardware Chromium')
const launch = hardwareLaunch(platform(), smoke, smoke && args.includes('--smoke-headed'))
const headless = launch.headless
const value = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback)
const output = resolve(value('--output', join(root, smoke ? 'smoke' : 'results')))
const repetitions = measurementRepetitions(args, manifest.settings.repetitions)
const smokeHistoryRows = Number(value('--smoke-history-rows', 64))
assert(
  Number.isInteger(smokeHistoryRows) &&
    smokeHistoryRows > 0 &&
    smokeHistoryRows <= manifest.settings.scrollback,
  'Smoke history rows must be within the scrollback limit',
)
let counts = selection(
  args,
  '--counts',
  manifest.settings.counts.map(String),
  manifest.settings.counts.map(String),
).map(Number)
const fixtures = selection(
  args,
  '--fixtures',
  manifest.fixtures.map(({ name }) => name),
  manifest.fixtures.map(({ name }) => name),
)
const writePaths = selection(args, '--paths', ['bytes', 'string'], ['bytes', 'string'])
if (smoke) counts = [Number(value('--smoke-count', 1))]
if (tracing && args.includes('--trace-count')) counts = [Number(value('--trace-count', 1))]
assert(
  counts.every((count) => manifest.settings.counts.includes(count)),
  'Terminal count must be 1, 8, or 17',
)
const variantIds = selectedVariants(
  args,
  manifest.variants.map(({ id }) => id),
  smoke && !args.includes('--smoke-instrumentation')
    ? manifest.variants.map(({ id }) => id)
    : ['ghostty-webgpu', 'xterm-webgl'],
)
const s = manifest.settings
const ownedComputePids = []
const gpuGate = createGpuGate(s, { allowedComputePids: ownedComputePids })
if (!smoke && platform() === 'darwin') {
  const power = execFileSync('/usr/bin/pmset', ['-g', 'batt'], { encoding: 'utf8' })
  assert(power.includes("'AC Power'"), 'waiting for AC')
  assert(
    args.includes('--display-awake'),
    'Mac measurements require caffeinate -d -u -t 1800 and --display-awake',
  )
}
const latencySamples = positiveInteger(
  args,
  args.includes('--trace-latency-samples') ? '--trace-latency-samples' : '--latency-samples',
  s.latencySamples,
)
const outputFrames = positiveInteger(args, '--output-frames', s.outputFrames)
const tickSeconds =
  platform() === 'linux'
    ? 1 / Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim())
    : null
const cpuOptions = { tickSeconds }
const traceFrames = positiveInteger(args, '--trace-frames', 180)
const tracePhases = selection(
  args,
  '--trace-phase',
  ['latency', 'ascii', 'sgr'],
  ['latency', 'ascii', 'sgr'],
)
await prepareOutput(output, { tracing })
const temporary = join(root, 'tmp')
await mkdir(temporary, { recursive: true })
process.env.TMPDIR = temporary
const contentTypes = {
  '.wasm': 'application/wasm',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.html': 'text/html',
}
const files = new Map()
for (const name of ['index.html', 'browser.js', ...Object.keys(manifest.assets)]) {
  const bytes = await readFile(join(root, name))
  verifyHash(bytes, name === 'browser.js' ? manifest.bundleSha256 : manifest.assets[name], name)
  files.set(`/${name}`, bytes)
}
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname
  if (!files.has(pathname) && pathname !== '/' && pathname !== '/favicon.ico')
    console.error(`Missing asset: ${pathname}`)
  const path = pathname === '/' ? '/index.html' : pathname
  const bytes = files.get(path)
  if (path === '/favicon.ico') {
    response.writeHead(204).end()
    return
  }
  if (!bytes) {
    response.writeHead(404).end()
    return
  }
  const extension = path.slice(path.lastIndexOf('.'))
  response
    .writeHead(200, {
      'content-type': contentTypes[extension] ?? 'text/plain',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    })
    .end(bytes)
})
const echo = new WebSocketServer({ server, path: '/echo' })
echo.on('connection', (socket) =>
  socket.on('message', (data) => socket.send(data, { binary: true })),
)
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const browserArgs = [
  `--force-device-scale-factor=${s.dpr}`,
  '--enable-unsafe-webgpu',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--max-active-webgl-contexts=32',
  ...launch.arguments,
]
let launchEnv = process.env
if (smoke && platform() === 'linux') {
  browserArgs.push(
    '--use-angle=vulkan',
    '--enable-features=Vulkan,VulkanFromANGLE',
    '--use-webgpu-adapter=swiftshader',
  )
  const driver = join(dirname(chromium.executablePath()), 'vk_swiftshader_icd.json')
  launchEnv = { ...process.env, VK_ICD_FILENAMES: driver, VK_DRIVER_FILES: driver }
}
let browser
let browserSession
const artifact = {
  schema: 1,
  sessionId: randomUUID(),
  manifest,
  smoke,
  tracing,
  repetitions: smoke ? 1 : repetitions,
  latencySamples,
  outputFrames,
  cpuTickSeconds: tickSeconds,
  counts,
  variants: variantIds,
  phases,
  frameBuilders: builders,
  paths: tracing ? ['bytes'] : writePaths,
  fixtures,
  hardware: false,
  measurementBudgetMilliseconds:
    counts.length *
    (tracing ? 1 : writePaths.length) *
    (variantIds.length + (variantIds.includes('ghostty-webgpu') ? builders.length - 1 : 0)) *
    (smoke ? 1 : repetitions) *
    s.caseDeadlineMilliseconds,
  startedAt: new Date().toISOString(),
  environment: {},
  runs: [],
  qualifications: [],
  tracePhases: tracing ? tracePhases : undefined,
  traceCounts: tracing ? counts : undefined,
  traceLatencySamples: tracing ? latencySamples : undefined,
  traceFrames: tracing ? traceFrames : undefined,
}
const artifactPath = join(output, 'comparison.json')

function renderer(info) {
  return info.gpu?.auxAttributes?.glRenderer ?? 'unknown'
}

async function processCpu(session) {
  const { processInfo } = await session.send('SystemInfo.getProcessInfo')
  return processInfo
}

async function memory(page, session, browserSession) {
  await session.send('HeapProfiler.collectGarbage')
  const heap = await session.send('Runtime.getHeapUsage')
  const info = await page.evaluate(() => window.__compare.info())
  let rssBytes = null
  if (platform() === 'darwin') {
    const processes = await processCpu(browserSession)
    const rss = execFileSync(
      '/bin/ps',
      ['-o', 'rss=', '-p', processes.map(({ id }) => id).join(',')],
      { encoding: 'utf8' },
    )
    rssBytes = rss
      .trim()
      .split(/\s+/)
      .reduce((sum, value) => sum + Number(value) * 1024, 0)
  }
  return { heap, wasmBytes: info.wasmBytes, rssBytes }
}

async function capturedFrames(session) {
  let pending
  const events = []
  let latest
  let latestData
  let latestMetadata
  const listener = (event) => {
    void session.send('Page.screencastFrameAck', { sessionId: event.sessionId })
    latestData = event.data
    latestMetadata = event.metadata
    latest = { timestamp: event.metadata.timestamp * 1000, colors: ink(event.data) }
    events.push({ ...latest, metadata: event.metadata, encodedBytes: event.data.length })
    if (!pending || !matches(latest, pending)) return
    clearTimeout(pending.timer)
    pending.resolve(latest)
    pending = undefined
  }
  const matches = (frame, target) =>
    frame.timestamp >= target.after &&
    frame.colors[target.color] > 0 &&
    frame.colors[target.color === 'red' ? 'green' : 'red'] === 0
  session.on('Page.screencastFrame', listener)
  await session.send('Page.startScreencast', {
    format: 'png',
    maxWidth: s.viewport.width,
    maxHeight: s.viewport.height,
    everyNthFrame: 1,
  })
  return {
    events,
    wait(color, after) {
      if (latest && matches(latest, { color, after })) return Promise.resolve(latest)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending = undefined
          const error = new Error(
            `Presented ${color} glyph timed out; latest capture: ${JSON.stringify(latest)}`,
          )
          error.captureData = latestData
          error.captureMetadata = latestMetadata
          reject(error)
        }, 10_000)
        pending = { color, after, resolve, timer }
      })
    },
    async close() {
      if (pending) clearTimeout(pending.timer)
      await session.send('Page.stopScreencast')
      session.off('Page.screencastFrame', listener)
    },
  }
}

async function captureSmoke(page, session) {
  const frames = await capturedFrames(session)
  try {
    await page.evaluate(() => window.__compare.smokeMarker())
    const written = await frames.wait('red', 0)
    await page.evaluate(() => window.__compare.prepareInput('green'))
    await page.keyboard.press('#')
    const echoed = await frames.wait('green', 0)
    return { written: written.colors, echoed: echoed.colors }
  } finally {
    await frames.close()
  }
}

async function latency(
  page,
  session,
  { samples: count = latencySamples, delayFrames = 0, writeOnly = false } = {},
) {
  await page.evaluate(() => window.__compare.smokeMarker())
  await page.evaluate(() => window.__compare.connectEcho())
  const frames = await capturedFrames(session)
  const samples = { write: [], input: [], captures: [], captureStream: frames.events }
  try {
    for (let index = -2; index < count; index++) {
      const color = index % 2 ? 'red' : 'green'
      const started = await page.evaluate(
        ({ color, delayFrames }) => window.__compare.writeMarker(color, delayFrames),
        { color, delayFrames },
      )
      const shown = await frames.wait(color, started)
      if (index >= 0) {
        samples.write.push(shown.timestamp - started)
        samples.captures.push({ operation: 'write', started, ...shown })
      }
    }
    if (writeOnly) return samples
    for (let index = -2; index < count; index++) {
      const color = index % 2 ? 'red' : 'green'
      await page.evaluate((color) => window.__compare.prepareInput(color), color)
      await page.keyboard.press('#')
      const started = await page.evaluate(() => window.__compare.keyTime())
      assert(started > 0, 'Keydown timestamp required')
      const shown = await frames.wait(color, started)
      if (index >= 0) {
        samples.input.push(shown.timestamp - started)
        samples.captures.push({ operation: 'input', started, ...shown })
      }
    }
    return samples
  } catch (error) {
    error.partialLatency = samples
    throw error
  } finally {
    await frames.close()
  }
}

async function parserCheck(page, name, size) {
  try {
    return {
      size,
      ...(await page.evaluate(({ name, size }) => window.__compare.smokeParse(name, size), {
        name,
        size,
      })),
    }
  } catch (error) {
    return { size, error: String(error.stack ?? error) }
  }
}

async function parserFixture(page, name, bytes) {
  try {
    if (smoke) {
      const checks = []
      for (const size of [s.chunkBytes, 1]) checks.push(await parserCheck(page, name, size))
      return { checks }
    }
    await page.evaluate((name) => window.__compare.parse(name, 8192), name)
    const sample = await page.evaluate(({ name, bytes }) => window.__compare.parse(name, bytes), {
      name,
      bytes,
    })
    assert.equal(sample.validation.qualified, true)
    return sample
  } catch (error) {
    return { error: String(error.stack ?? error) }
  }
}

async function parserOnly(testCase, run, contexts) {
  const context = await browser.newContext({ viewport: s.viewport, deviceScaleFactor: s.dpr })
  contexts.add(context)
  try {
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(
      `${origin}/?${new URLSearchParams({ ...(!smoke || args.includes('--smoke-instrumentation') ? { trace: '' } : {}), ...(testCase.frameBuilder === 'zig' ? { zig: '' } : {}) })}`,
    )
    await page.waitForFunction(() => Boolean(window.__compare))
    await page.evaluate((testCase) => window.__compare.initialize(testCase), testCase)
    run.parse = {}
    run.parserErrors = []
    for (const { name, bytes } of manifest.fixtures.filter(({ name }) => fixtures.includes(name))) {
      run.phase = `parser/${name}`
      const sample = smoke
        ? await parserFixture(page, name, bytes)
        : await qualifiedWindow(run, `parser/${name}`, () => parserFixture(page, name, bytes))
      run.parse[name] = sample
      if (sample.error) run.parserErrors.push({ name, error: sample.error })
      for (const check of sample.checks ?? []) {
        if (check.error) run.parserErrors.push({ name, ...check })
      }
    }
    assert.deepEqual(errors, [])
    run.parseQualified = run.parserErrors.length === 0
  } finally {
    await context.close()
    contexts.delete(context)
  }
}

async function measure(testCase, repetition, browserSession) {
  const run = {
    ...testCase,
    repetition,
    pairId: `${repetition}/${testCase.path}/${testCase.count}`,
    sessionId: artifact.sessionId,
    executionOrder: artifact.runs.length,
    status: 'running',
  }
  const contexts = new Set()
  const remaining = smoke
    ? 120_000
    : artifact.measurementBudgetMilliseconds - (Date.now() - Date.parse(artifact.startedAt))
  try {
    const result = await withDeadline(
      () => measureBody(testCase, repetition, browserSession, run, contexts),
      Math.min(s.caseDeadlineMilliseconds, remaining),
      () => Promise.all([...contexts].map((context) => context.close().catch(() => {}))),
      { drain: true },
    )
    result.status =
      result.error || result.phases?.some((phase) => phase.error) ? 'failed' : 'complete'
    return result
  } catch (error) {
    if (String(error).includes('Mac display unavailable')) throw error
    run.error = String(error.stack ?? error)
    run.status = 'failed'
    if (error instanceof ComparisonDeadlineError) {
      error.run = run
      throw error
    }
    return run
  }
}

async function qualifyDisplay(page, session, browserSession, run, idle = true) {
  const metadata = {
    variant: run.variant,
    frameBuilder: run.frameBuilder,
    count: run.count,
    repetition: run.repetition,
    phase: run.phase,
    kind: idle ? 'idle-display' : 'mounted-workload',
  }
  let probe
  try {
    probe = await displayProbe({ page, session, browserSession, metadata })
  } catch (error) {
    probe = {
      ...metadata,
      frameCount: 0,
      median: null,
      p95: null,
      max: null,
      periods: [],
      error: String(error),
    }
  }
  artifact.qualifications.push(probe)
  await writeFile(
    join(output, 'qualification.json'),
    JSON.stringify(
      { environment: artifact.environment, qualifications: artifact.qualifications },
      null,
      2,
    ) + '\n',
  )
  assertDisplay(probe, { idle, expectedPeriod: tracing && platform() === 'darwin' ? 16.67 : null })
  return probe
}

async function refreshGpuOwnership() {
  const processes = await processCpu(browserSession)
  ownedComputePids.splice(0, ownedComputePids.length, ...processes.map(({ id }) => id))
}

async function qualifiedWindow(run, label, operation) {
  run.gpuWindows ??= []
  try {
    await refreshGpuOwnership()
    const idle = await gpuGate.waitForIdle()
    run.gpuWindows.push({ label, idle })
    const sampleMilliseconds = ['idle', 'output/ascii', 'latency', 'delayed-write'].includes(label)
      ? s.gpuMeasuredSampleMilliseconds
      : s.gpuSampleMilliseconds
    const { value, gpu } = await gpuGate.monitorWindow(operation, { sampleMilliseconds })
    run.gpuWindows.at(-1).window = gpu
    const skipped = idle.skipReason ?? gpu.skipReason ?? run.gpuIdle?.skipped
    run.gpuIdle = { qualified: true, ...(skipped ? { skipped } : {}) }
    return value
  } catch (error) {
    if (error.evidence) {
      run.gpuIdle = { qualified: false, reason: error.message }
      run.gpuWindows.push({ label, failure: error.evidence })
    }
    throw error
  }
}

async function presentedLatency(page, session, browserSession, run, label, options) {
  const phase = await qualifiedWindow(run, label, () =>
    tracePhase({
      page,
      session,
      browserSession,
      output,
      label: `${run.variant}${run.frameBuilder ? `-${run.frameBuilder}` : ''}-${run.path}-${run.count}-${run.repetition}-${label}`,
      categories:
        'toplevel,devtools.timeline,blink.user_timing,cc,viz,gpu,disabled-by-default-devtools.timeline',
      operation: async () => {
        const sample = await latency(page, session, options)
        // Feedback can arrive after the PNG; drain it before closing the trace.
        await page.waitForTimeout(s.presentationDrainMilliseconds)
        return sample
      },
      traced: true,
    }),
  )
  assert(!phase.error, phase.error)
  const trace = JSON.parse(gunzipSync(await readFile(join(output, phase.trace))).toString())
  return { ...presentationLatency(phase, trace.traceEvents), trace: phase.trace }
}

async function measureBody(testCase, repetition, browserSession, run, contexts) {
  if (
    !tracing &&
    phases.includes('parser') &&
    !args.includes('--smoke-instrumentation') &&
    (testCase.count === 1 || smoke)
  )
    await parserOnly(testCase, run, contexts)
  run.phase = 'rendered/prepare'
  const context = await browser.newContext(
    tracing && platform() === 'darwin'
      ? { viewport: null }
      : { viewport: s.viewport, deviceScaleFactor: s.dpr },
  )
  contexts.add(context)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  run.originalUnicodeTrace = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
    const prefix = 'legacy-original-unicode '
    if (message.text().startsWith(prefix))
      run.originalUnicodeTrace.push(JSON.parse(message.text().slice(prefix.length)))
  })
  try {
    await page.goto(
      `${origin}/?${new URLSearchParams({ ...(!smoke || args.includes('--smoke-instrumentation') ? { trace: '' } : {}), ...(testCase.frameBuilder === 'zig' ? { zig: '' } : {}) })}`,
    )
    await page.waitForFunction(() => Boolean(window.__compare))
    await page.bringToFront()
    const session = await context.newCDPSession(page)
    if (tracing && platform() === 'darwin')
      run.window = await fitWindow(page, browserSession, session)
    if (!smoke) {
      run.phase = 'idle-display/qualification'
      run.idleDisplay = await qualifyDisplay(page, session, browserSession, run)
    }
    run.phase = 'rendered/prepare'
    let empty
    if (!smoke && phases.includes('memory')) empty = await memory(page, session, browserSession)
    await page.evaluate((testCase) => window.__compare.prepare(testCase), testCase)
    const info = await page.evaluate(() => window.__compare.info())
    if (!smoke && testCase.variant === 'ghostty-webgpu')
      assert(info.adapter?.fallback === false, 'Software WebGPU adapter rejected')
    run.info = info
    if (!smoke && !tracing && phases.includes('memory')) {
      const initial = await memory(page, session, browserSession)
      run.historyLengths = await page.evaluate(() => window.__compare.history())
      const history = await memory(page, session, browserSession)
      run.memory = { empty, initial, history }
    }
    if (tracing) run.historyLengths = await page.evaluate(() => window.__compare.history())
    run.correctness = await page.evaluate(() => window.__compare.correctness())
    if (tracing) {
      run.grid = await fitGrid(page)
      assert.deepEqual(run.grid.backingBefore, run.grid.backingAfter)
      assert(
        run.grid.sections.every(
          (bounds) =>
            bounds.left >= 0 &&
            bounds.top >= 0 &&
            bounds.right <= run.grid.innerWidth &&
            bounds.bottom <= run.grid.innerHeight,
        ),
        'Every terminal must fit the visible window',
      )
    }
    const screenshot = `${testCase.variant}${testCase.frameBuilder ? `-${testCase.frameBuilder}` : ''}-${testCase.path}-${testCase.count}.png`
    if (repetition === 0) {
      await page.locator('main').screenshot({ path: join(output, screenshot) })
      run.screenshot = screenshot
    }
    if (smoke) {
      // Smoke deliberately calls no timing probes, even on software adapters.
      await page.evaluate(() => window.__compare.smokeMarker())
      const colors = ink((await page.screenshot()).toString('base64'))
      assert(colors.red > 5, 'Written glyph must be visible')
      await page.evaluate(() => window.__compare.connectEcho())
      await page.evaluate(() => window.__compare.prepareInput('green'))
      await page.keyboard.press('#')
      await page.waitForFunction(() => window.__compare.info().texts[0][0].includes('#'))
      const echoColors = ink((await page.screenshot()).toString('base64'))
      assert(echoColors.green > 0 && echoColors.red === 0, 'Echoed glyph must be visible')
      if (args.includes('--smoke-capture')) run.captureCheck = await captureSmoke(page, session)
      run.historyLengths = await page.evaluate(
        (rows) => window.__compare.history(rows),
        smokeHistoryRows,
      )
      run.phase = 'diagnostic/legacy-empty-write'
      run.emptyWriteProbe = await page.evaluate(() => window.__compare.legacyEmptyWrite())
      assert.deepEqual(errors, [])
      run.phase = 'diagnostic/legacy-original-unicode'
      run.originalUnicodeProbe = await page
        .evaluate(() => window.__compare.legacyOriginalUnicode())
        .catch((error) => ({ error: String(error.stack ?? error) }))
      if (args.includes('--smoke-instrumentation')) {
        await page.evaluate(() => window.__compare.traceBegin())
        await page.evaluate(() => window.__compare.burst('ascii', 2))
        run.instrumentationCheck = await page.evaluate(() => window.__compare.traceEnd())
      }
      run.status = 'correctness-only'
      return run
    }
    const initialProbe = await qualifyDisplay(page, session, browserSession, run, false)
    run.refreshPeriods = run.idleDisplay.periods
    run.refreshPeriod = run.idleDisplay.median
    run.mountedDisplay = initialProbe
    if (run.grid)
      assert.deepEqual(
        initialProbe.canvases,
        run.grid.backingBefore,
        'Fitting the window must preserve canvas backing sizes',
      )
    if (tracing) {
      run.phases = []
      const configurations = [
        { name: 'latency', operation: () => latency(page, session) },
        ...['ascii', 'sgr'].map((name) => ({
          name,
          operation: () =>
            page.evaluate(({ name, frames }) => window.__compare.burst(name, frames), {
              name,
              frames: traceFrames,
            }),
        })),
      ]
      for (const { name, operation } of configurations) {
        if (!tracePhases.includes(name)) continue
        run.phase = `trace/${name}`
        if (name !== 'latency') await page.evaluate((name) => window.__compare.burst(name, 8), name)
        for (const traced of repetition % 2 ? [true, false] : [false, true]) {
          run.phase = `trace/${name}/${traced ? 'trace' : 'control'}/mounted-probe`
          const probe = await qualifyDisplay(page, session, browserSession, run, false)
          const refreshPeriods = probe.periods
          const label = `${testCase.variant}${testCase.frameBuilder ? `-${testCase.frameBuilder}` : ''}-${testCase.count}-${repetition}-${name}-${traced ? 'trace' : 'control'}`
          run.phases.push(
            Object.assign(
              await qualifiedWindow(run, label, () =>
                tracePhase({ page, session, browserSession, output, label, operation, traced }),
              ),
              { refreshPeriods },
            ),
          )
        }
      }
      assert.deepEqual(errors, [])
      return run
    }
    if (phases.includes('idle'))
      run.idle = await qualifiedWindow(run, 'idle', () =>
        measureCpu(browserSession, () => page.waitForTimeout(s.idleMilliseconds), cpuOptions),
      )
    run.phase = 'presentation-feedback latency'
    if (phases.includes('latency'))
      run.latency = await presentedLatency(page, session, browserSession, run, 'latency')
    if (args.includes('--validate-presentation') && repetition === 0 && testCase.count === 1)
      run.presentationValidation = await presentedLatency(
        page,
        session,
        browserSession,
        run,
        'delayed-write',
        {
          samples: s.presentationValidationSamples,
          delayFrames: s.presentationValidationDelayFrames,
          writeOnly: true,
        },
      )
    run.burst = {}
    for (const { name } of manifest.fixtures.filter(
      ({ name }) => phases.includes('burst') && fixtures.includes(name),
    )) {
      run.phase = `burst/${name}/warmup`
      await page.evaluate((name) => window.__compare.burst(name, 3), name)
      run.phase = `burst/${name}/measured`
      run.burst[name] = await qualifiedWindow(run, `burst/${name}`, () =>
        page.evaluate(({ name, frames }) => window.__compare.burst(name, frames), {
          name,
          frames: s.burstFrames,
        }),
      )
    }
    if (phases.includes('output')) {
      run.phase = 'output/ascii/warmup'
      await page.evaluate(() => window.__compare.burst('ascii', 3))
      run.phase = 'output/ascii'
      const outputMeasurement = await qualifiedWindow(run, 'output/ascii', () =>
        measureCpu(
          browserSession,
          () => page.evaluate((frames) => window.__compare.burst('ascii', frames), outputFrames),
          cpuOptions,
        ),
      )
      run.output = {
        ...outputMeasurement.sample,
        cpu: outputMeasurement.cpu,
        memory: phases.includes('memory') ? await memory(page, session, browserSession) : undefined,
      }
    }
    assert.deepEqual(errors, [])
    return run
  } catch (error) {
    if (String(error).includes('Mac display unavailable')) throw error
    run.error = String(error.stack ?? error)
    run.pageErrors = errors
    if (error.captureData) {
      run.captureFailure = error.captureMetadata
      await writeFile(
        join(
          output,
          `capture-failure-${testCase.variant}${testCase.frameBuilder ? `-${testCase.frameBuilder}` : ''}-${testCase.path}-${testCase.count}-${repetition}.png`,
        ),
        Buffer.from(error.captureData, 'base64'),
      )
    }
    run.failureInfo = await page
      .evaluate(() => ({
        info: window.__compare?.info(),
        visibility: document.visibilityState,
        rectangles: Array.from(document.querySelectorAll('canvas'), (canvas) => ({
          rect: canvas.getBoundingClientRect().toJSON(),
          style: canvas.getAttribute('style'),
        })),
      }))
      .catch(() => null)
    await page
      .screenshot({
        path: join(
          output,
          `failure-${testCase.variant}${testCase.frameBuilder ? `-${testCase.frameBuilder}` : ''}-${testCase.path}-${testCase.count}-${repetition}.png`,
        ),
      })
      .catch(() => {})
    return run
  } finally {
    await context.close()
    contexts.delete(context)
    run.pageErrors = errors
    if (errors.length && !run.error) run.error = 'Page errors during case completion'
  }
}

try {
  browser = await chromium.launch({
    channel: platform() === 'linux' && headless ? undefined : 'chromium',
    headless,
    args: browserArgs,
    env: launchEnv,
  })
  browserSession = await browser.newBrowserCDPSession()
  const gpu = await browserSession.send('SystemInfo.getInfo')
  artifact.hardware = !smoke && !/unknown|swiftshader|llvmpipe|software/i.test(renderer(gpu))
  assert(smoke || artifact.hardware, 'Hardware GPU required for measurements')
  artifact.environment = {
    browser: browser.version(),
    browserChannel: platform() === 'linux' && headless ? 'chromium-headless-shell' : 'chromium',
    latencyEndpoint: comparisonLatencyEndpoint({ tracing, headless, platform: platform() }),
    os: `${platform()} ${release()} ${arch()}`,
    cpu: cpus()[0]?.model,
    renderer: renderer(gpu),
    gpu,
    headed: !headless,
    headless,
    displayAwake: args.includes('--display-awake') ? 'caffeinate -d -u -t 1800' : null,
    arguments: args,
    launchArguments: browserArgs,
    power:
      platform() === 'darwin'
        ? execFileSync('/usr/bin/pmset', ['-g', 'batt'], { encoding: 'utf8' })
        : null,
  }
  artifact.environment.gpuIdleSettings = Object.fromEntries(
    Object.entries(s).filter(([key]) => key.startsWith('gpu')),
  )
  for (let repetition = 0; repetition < artifact.repetitions; repetition++) {
    if (!smoke) {
      try {
        await refreshGpuOwnership()
        artifact.qualifications.push({
          ...(await gpuGate.waitForIdle()),
          kind: 'between-repetitions-gpu',
          repetition,
        })
      } catch (error) {
        artifact.qualifications.push({
          ...error.evidence,
          kind: 'between-repetitions-gpu',
          repetition,
          error: error.message,
        })
        throw error
      }
    }
    const cases = measurementCases(
      variantIds,
      tracing ? ['bytes'] : writePaths,
      counts,
      builders,
      repetition,
    )
    for (const testCase of cases) {
      if (!smoke && platform() === 'darwin')
        assert(
          execFileSync('/usr/bin/pmset', ['-g', 'batt'], { encoding: 'utf8' }).includes(
            "'AC Power'",
          ),
          'AC power lost; stopping measurement',
        )
      assert(
        smoke ||
          Date.now() - Date.parse(artifact.startedAt) < artifact.measurementBudgetMilliseconds,
        'Configured measurement budget expired',
      )
      console.log(
        `${smoke ? 'Correctness' : 'Measure'} ${repetition + 1}/${artifact.repetitions} ${testCase.variant}/${testCase.path}/${testCase.count}`,
      )
      artifact.runs.push(await measure(testCase, repetition, browserSession))
      await writeFile(artifactPath, JSON.stringify(artifact, null, 2) + '\n')
      if (artifact.runs.at(-1).error)
        console.error(
          `Failed case retained: ${testCase.variant}/${testCase.path}/${testCase.count}`,
        )
    }
  }
  artifact.finishedAt = new Date().toISOString()
  if (!smoke && !tracing) {
    artifact.summary = summaries(artifact)
    await writeFile(join(output, 'benchmarks.md'), markdown(artifact))
  }
} catch (error) {
  artifact.error = String(error.stack ?? error)
  if (error.run) artifact.runs.push(error.run)
  if (String(error).includes('Mac display unavailable')) {
    if (tracing) await discardTraceWindow(output)
    artifact.runs = []
    artifact.invalid = 'Mac display unavailable'
  }
  throw error
} finally {
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2) + '\n')
  await writeFile(
    join(output, 'qualification.json'),
    JSON.stringify(
      {
        environment: artifact.environment,
        qualifications: artifact.qualifications,
        runs: artifact.runs.map(({ variant, count, repetition, gpuWindows }) => ({
          variant,
          count,
          repetition,
          gpuWindows,
        })),
      },
      null,
      2,
    ) + '\n',
  )
  await browser?.close()
  echo.close()
  await new Promise((resolve) => server.close(resolve))
}
console.log(`Artifact: ${artifactPath}`)
if (
  artifact.runs.some(
    (run) => run.error || run.parserErrors?.length || run.phases?.some((phase) => phase.error),
  )
)
  process.exitCode = 1

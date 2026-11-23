import assert from 'node:assert/strict'
import { PNG } from 'pngjs'
import { studyCanvases, qualifyStudyPaint } from './study-qualification.mjs'
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve, extname } from 'node:path'
import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'
import { createServer } from 'node:http'
import { createGpuGate } from './comparison-gpu.mjs'
import { measureCpu } from './comparison-guards.mjs'

const bundle = resolve(process.argv[2])
const output = resolve(process.argv[3])
const mode = process.argv[4] ?? 'smoke'
const variants = (
  process.env.STUDY_VARIANTS ?? 'ghostty-webgpu,ghostty-webgl,xterm-webgl,wraith-native'
).split(',')
if (process.env.STUDY_FENCED === '1')
  assert(
    variants.every((variant) =>
      ['ghostty-webgpu', 'ghostty-worker-webgpu', 'wraith-native'].includes(variant),
    ),
    'GPU completion requires an instrumented WebGPU entry',
  )
const counts = (process.env.STUDY_COUNTS ?? '1').split(',').map(Number)
const fixtures = (process.env.STUDY_FIXTURES ?? 'ascii,sgr,cursor,rolling-logs').split(',')
const repetitions = mode === 'smoke' ? 1 : Number(process.env.STUDY_REPETITIONS ?? 4)
const repetitionOffset = Number(process.env.STUDY_REPETITION_OFFSET ?? 0)
const steps = Number(process.env.STUDY_STEPS ?? 120)
const dpr = Number(process.env.STUDY_DPR ?? 2)
const traced = process.env.STUDY_TRACE === '1'
const workloadRoot = process.env.STUDY_WORKLOAD_ROOT
const workloads = {}
if (workloadRoot) {
  for (const fixture of fixtures) {
    const meta = JSON.parse(await readFile(join(workloadRoot, `${fixture}.json`), 'utf8'))
    const bytes = await readFile(join(workloadRoot, `${fixture}.bin`))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), meta.sha256)
    workloads[fixture] = {
      meta,
      chunks: meta.chunks.map(({ offset, length }) =>
        Array.from(bytes.subarray(offset, offset + length)),
      ),
    }
  }
}
const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8'))
const gate = createGpuGate(manifest.settings)
const result = {
  workloads: Object.fromEntries(
    Object.entries(workloads).map(([name, value]) => [name, value.meta]),
  ),
  experimental: true,
  mode,
  bundle,
  startedAt: new Date().toISOString(),
  runs: [],
}
await mkdir(output, { recursive: true })
const args = [
  '--ignore-gpu-blocklist',
  '--enable-unsafe-webgpu',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--max-active-webgl-contexts=32',
]
if (process.platform === 'linux') args.push('--ozone-platform=wayland')
const temporary = await mkdtemp(
  join(process.platform === 'linux' ? '/work/tmp' : tmpdir(), 'ghw-p0b-'),
)
process.env.TMPDIR = temporary
let browser
let session
const server = createServer((request, response) => void serve(request, response))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
async function cleanup() {
  await browser?.close()
  server.closeAllConnections()
  server.close()
  await rm(temporary, { recursive: true, force: true })
}
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
])
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(code))
  })
try {
  if (process.platform === 'linux') {
    result.freeVramMiB = Number(
      execFileSync('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], {
        encoding: 'utf8',
      }).trim(),
    )
    assert(result.freeVramMiB >= 2048, 'At least 2 GiB free VRAM required')
  }
  browser = await chromium.launch({ channel: 'chromium', headless: false, args })
  session = await browser.newBrowserCDPSession()
  result.environment = {
    runnerSha256: createHash('sha256')
      .update(await readFile(new URL(import.meta.url)))
      .digest('hex'),
    browser: browser.version(),
    headless: false,
    args,
    gpu: await session.send('SystemInfo.getInfo'),
    processes: await session.send('SystemInfo.getProcessInfo'),
  }
  const browserPid = result.environment.processes.processInfo.find((p) => p.type === 'browser').id
  result.environment.observedArgv =
    process.platform === 'linux'
      ? (await readFile(`/proc/${browserPid}/cmdline`, 'utf8')).split('\0')
      : execFileSync('ps', ['-p', String(browserPid), '-o', 'command='], { encoding: 'utf8' })
          .trim()
          .split(' ')
  assert(
    !result.environment.observedArgv.some((arg) => arg.startsWith('--headless')),
    'Actual headed required',
  )
  assert(
    !/swiftshader|llvmpipe|software/i.test(result.environment.gpu.gpu.auxAttributes.glRenderer),
    'Hardware required',
  )
  for (let repetition = 0; repetition < repetitions; repetition++)
    await repetitionRun(repetition + repetitionOffset)
} finally {
  result.finishedAt = new Date().toISOString()
  await writeFile(join(output, 'results.json'), JSON.stringify(result, null, 2))
  await cleanup()
}

async function repetitionRun(repetition) {
  const ordered = repetition % 2 ? variants.toReversed() : variants
  const orderedCounts = repetition % 2 ? counts.toReversed() : counts
  for (const count of orderedCounts) {
    for (const variant of ordered) await run({ variant, count, path: 'bytes', repetition })
  }
}

async function processMemory() {
  const { processInfo } = await session.send('SystemInfo.getProcessInfo')
  return Promise.all(
    processInfo.map(async (process) => {
      try {
        const raw = await readFile(`/proc/${process.id}/smaps_rollup`, 'utf8')
        return {
          id: process.id,
          type: process.type,
          rssKiB: Number(raw.match(/^Rss:\s+(\d+)/m)?.[1]),
          pssKiB: Number(raw.match(/^Pss:\s+(\d+)/m)?.[1]),
        }
      } catch (error) {
        return { id: process.id, type: process.type, error: String(error) }
      }
    }),
  )
}

// A real server also answers requests workers make themselves, such as lazy module chunks.
async function serve(request, response) {
  const path = new URL(request.url, 'http://study.invalid').pathname
  const name = path === '/' ? 'index.html' : path.slice(1)
  // A missing favicon would log a console error and fail the run's clean-console check.
  if (name === 'favicon.ico') {
    response.writeHead(204)
    response.end()
    return
  }
  const types = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.wasm': 'application/wasm',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
  }
  try {
    const body = await readFile(join(bundle, name))
    response.writeHead(200, { 'content-type': types[extname(name)] ?? 'text/plain' })
    response.end(body)
  } catch {
    response.writeHead(404)
    response.end(name)
  }
}

function installContextObserver() {
  const original = HTMLCanvasElement.prototype.getContext
  window.__contexts = []
  HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
    const context = original.call(this, kind, ...args)
    if (!context) return context
    this.dataset.studyContext = kind
    let renderer
    if (kind === 'webgl2' || kind === 'webgl') {
      const debug = context.getExtension('WEBGL_debug_renderer_info')
      renderer = debug ? context.getParameter(debug.UNMASKED_RENDERER_WEBGL) : undefined
    }
    window.__contexts.push({ kind, renderer })
    return context
  }
}

async function run(testCase) {
  const { variant, count, repetition } = testCase
  console.log(JSON.stringify(testCase))
  if (process.platform === 'linux') {
    const free = Number(
      execFileSync('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], {
        encoding: 'utf8',
      }).trim(),
    )
    assert(
      free >= 2048,
      `At least 2 GiB free VRAM required before ${variant}, observed ${free} MiB`,
    )
  }
  const context = await browser.newContext({
    viewport: { width: 3360, height: 2560 },
    deviceScaleFactor: dpr,
  })
  await context.addInitScript(installContextObserver)
  const page = await context.newPage()
  const errors = []
  const workerAdapters = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
    if (message.text().startsWith('STUDY_WEBGPU_ADAPTER '))
      workerAdapters.push(JSON.parse(message.text().slice('STUDY_WEBGPU_ADAPTER '.length)))
  })
  const run = {
    ...testCase,
    startedAt: new Date().toISOString(),
    errors,
    workerAdapters,
    workloads: {},
  }
  result.runs.push(run)
  try {
    await page.goto(`${origin}/?study=1`)
    await page.waitForFunction(() => window.__compare)
    await page.evaluate((testCase) => window.__compare.initialize(testCase), testCase)
    await Promise.race([
      page.evaluate(() => window.__compare.createTerminals()),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Terminal creation exceeded 30 seconds')), 30000).unref(),
      ),
    ])
    await page.evaluate(
      (enabled) => window.__compare.studyFence?.(enabled),
      process.env.STUDY_FENCED === '1',
    )
    run.correctness = await page.evaluate(() => window.__compare.correctness())
    run.info = await page.evaluate(() => window.__compare.studyInfo())
    run.info.canvases = await page.evaluate(studyCanvasInfo)
    assert.equal(run.info.dpr, dpr, 'Configured DPR required')
    run.contexts = await page.evaluate(() => window.__contexts)
    await qualifyPaint(page, run)
    if (repetition === 0 && process.env.STUDY_FENCED !== '1')
      await page.screenshot({ path: join(output, `${variant}-${count}.png`), timeout: 5000 })
    if (mode === 'smoke') {
      run.status = 'qualified'
      return
    }
    const cdp = await context.newCDPSession(page)
    for (const fixture of fixtures) {
      run.activeFixture = fixture
      await measureWorkload(page, run, fixture, repetition, variant, count)
    }
    delete run.activeFixture
    run.idle = await measureCpu(session, () => page.waitForTimeout(1000), { tickSeconds: 0.01 })
    await cdp.send('HeapProfiler.collectGarbage')
    run.heap = await cdp.send('Runtime.getHeapUsage')
    run.processMemory = await processMemory()
    run.finalInfo = await page.evaluate(() => window.__compare.studyInfo())
    assert.deepEqual(errors, [])
    run.status = 'complete'
  } catch (error) {
    run.error = String(error.stack ?? error)
    run.gpuEvidence = error.evidence
    run.failedFixture = run.activeFixture
    run.status = 'failed'
    console.error(run.error)
  } finally {
    await context.close()
    await writeFile(join(output, 'results.json'), JSON.stringify(result, null, 2))
  }
}

function studyCanvasInfo() {
  return Array.from(document.querySelectorAll('main canvas'), (canvas) => ({
    context: canvas.dataset.studyContext,
    width: canvas.width,
    height: canvas.height,
    bounds: canvas.getBoundingClientRect().toJSON(),
  }))
}

async function qualifyPaint(page, run) {
  const canvases = studyCanvases(run.info, run.variant, run.count)
  await page.evaluate(() =>
    window.__compare.studyWrite('\x1bc\x1b[?1049h\x1b[?25l\x1b[48;2;25;100;200m\x1b[2J'),
  )
  await page.evaluate(async () => {
    await window.__compare.studyInfo()
    await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
  })
  const image = PNG.sync.read(
    await page.screenshot({
      path: join(output, `${run.variant}-${run.count}-r${run.repetition}-qualification.png`),
    }),
  )
  run.paintQualification = canvases.map((canvas) => {
    const crop = new PNG({ width: canvas.width, height: canvas.height })
    PNG.bitblt(
      image,
      crop,
      Math.round(canvas.bounds.x * dpr),
      Math.round(canvas.bounds.y * dpr),
      crop.width,
      crop.height,
      0,
      0,
    )
    return qualifyStudyPaint(crop.data)
  })
  studyCanvases(await page.evaluate(() => window.__compare.studyInfo()), run.variant, run.count)
}

async function measureWorkload(page, run, fixture, repetition, variant, count) {
  if (workloadRoot) {
    await page.evaluate(
      (chunks) => window.__compare.studyPrepare(chunks),
      workloads[fixture].chunks,
    )
    await page.evaluate(() => window.__compare.studyWrite('\x1bc\x1b[?25l'))
  } else {
    await page.evaluate((name) => window.__compare.burst(name, 3), fixture)
  }
  const beforeInfo = await page.evaluate(() => window.__compare.studyInfo())
  studyCanvases(beforeInfo, variant, count)
  const idle = await gate.waitForIdle()
  // Tracing perturbs timing: traced windows explain where time goes, they are not results.
  if (traced)
    await browser.startTracing(page, {
      categories: [
        'toplevel',
        'devtools.timeline',
        'disabled-by-default-devtools.timeline',
        'v8.execute',
        'disabled-by-default-v8.cpu_profiler',
        'gpu',
      ],
    })
  let window
  try {
    window = await gate.monitorWindow(
      () =>
        measureCpu(
          session,
          () =>
            page.evaluate(
              ({ name, steps, external }) =>
                external ? window.__compare.studyRun(steps) : window.__compare.burst(name, steps),
              { name: fixture, steps, external: Boolean(workloadRoot) },
            ),
          { tickSeconds: 0.01 },
        ),
      { sampleMilliseconds: 1000 },
    )
  } finally {
    if (traced)
      await writeFile(
        join(output, `${variant}-${count}-${fixture}-r${repetition}.trace.json.gz`),
        gzipSync(await browser.stopTracing()),
      )
  }
  run.workloads[fixture] = {
    ...window.value,
    traced,
    gpu: window.gpu,
    gpuIdle: idle,
    beforeInfo,
    afterInfo: await page.evaluate(() => window.__compare.studyInfo()),
  }
  if (repetition === 0 && workloadRoot && process.env.STUDY_FENCED !== '1')
    await page.screenshot({
      path: join(output, `${variant}-${count}-${fixture}.png`),
      timeout: 5000,
    })
  run.workloads[fixture].texts = await page.evaluate(
    async () => (await window.__compare.studyInfo()).texts,
  )
}

if (result.runs.some((run) => run.status === 'failed')) process.exitCode = 1

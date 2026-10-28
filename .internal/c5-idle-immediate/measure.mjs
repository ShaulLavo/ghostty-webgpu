import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { resolve, join } from 'node:path'
import { chromium } from 'playwright'
import { tracePhase } from '../../scripts/comparison-trace.mjs'
import { measureCpu } from '../../scripts/comparison-guards.mjs'
import { c5PresentationLatency } from './presentation.mjs'

const baseline = resolve(process.env.C5_BASELINE ?? '')
const candidate = resolve(process.env.C5_CANDIDATE ?? '')
const output = resolve(process.env.C5_OUTPUT ?? '')
assert(baseline && candidate && output, 'C5_BASELINE, C5_CANDIDATE and C5_OUTPUT are required')
const sampleCount = Number(process.env.C5_SAMPLES ?? 40)
const repetitions = Number(process.env.C5_REPETITIONS ?? 2)
const sustainedWrites = Number(process.env.C5_SUSTAINED_WRITES ?? 600)
const port = Number(process.env.C5_PORT ?? 41882)
const sources = { baseline, candidate }
const roots = Object.fromEntries(
  await Promise.all(
    Object.entries(sources).map(async ([label, root]) => [label, await buildSource(root)]),
  ),
)
await mkdir(output, { recursive: true })
const report = {
  schema: 1,
  startedAt: new Date().toISOString(),
  baselineSha: process.env.C5_BASELINE_SHA,
  candidateSha: process.env.C5_CANDIDATE_SHA,
  sampleCount,
  repetitions,
  sustainedWrites,
  arms: [],
}
let current
const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch(request) {
    const url = new URL(request.url)
    if (!current) return new Response('No active arm', { status: 503 })
    if (url.pathname === '/') {
      const source = url.searchParams.get('source')
      return new Response(
        `<!doctype html><style>body{margin:0;background:black}main{width:900px;height:500px}</style><main></main><script type="module" src="/bundle.js?source=${source}"></script>`,
        { headers: { 'content-type': 'text/html' } },
      )
    }
    if (url.pathname === '/bundle.js' || url.pathname === '/c5-worker.js') {
      const source = url.searchParams.get('source') ?? current.label
      const key = url.pathname === '/bundle.js' ? 'bundle' : 'worker'
      return new Response(current.roots[source][key], {
        headers: { 'content-type': 'text/javascript' },
      })
    }
    const file = current.files.get(url.pathname)
    if (!file) return new Response('', { status: 404 })
    return new Response(file, { headers: { 'content-type': 'application/octet-stream' } })
  },
})
const pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))
const conditions = [
  { backend: 'webgpu', worker: false },
  { backend: 'webgpu', worker: true },
  { backend: 'webgl2', worker: true },
  { backend: 'webgl2', worker: false },
]
try {
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    for (const [index, condition] of conditions.entries())
      await runCondition(condition, index, repetition)
  }
  report.finishedAt = new Date().toISOString()
} catch (error) {
  report.error = String(error)
  throw error
} finally {
  report.finishedAt ??= new Date().toISOString()
  await writeReport()
  server.stop(true)
}

async function runCondition(condition, index, repetition) {
  const conditionName = `${condition.backend}-${condition.worker ? 'worker' : 'main'}`
  if (process.env.C5_ONLY && process.env.C5_ONLY !== conditionName) return
  const order =
    (repetition + index) % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']
  for (const label of order) {
    if (process.env.C5_SOURCE && process.env.C5_SOURCE !== label) continue
    await runArm(label, condition, repetition)
  }
}

async function runArm(label, condition, repetition) {
  const name = `${condition.backend}-${condition.worker ? 'worker' : 'main'}-${label}-r${repetition}`
  console.log(`C5 ${name}`)
  current = { label, roots, files: roots[label].files }
  const arm = { name, label, ...condition, repetition, errors: [] }
  const pageErrors = []
  const consoleMessages = []
  report.arms.push(arm)
  let browser
  try {
    browser = await chromium.launch({
      channel: 'chromium',
      headless: false,
      args: ['--enable-unsafe-webgpu'],
    })
    arm.browser = browser.version()
    const context = await browser.newContext({
      viewport: { width: 1000, height: 650 },
      deviceScaleFactor: 2,
    })
    const page = await context.newPage()
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    page.on('console', (message) => consoleMessages.push(`${message.type()}: ${message.text()}`))
    const query = `source=${label}&backend=${condition.backend}&trace${condition.worker ? '&worker' : ''}${label === 'candidate' ? '&adaptive' : ''}`
    await page.goto(`http://127.0.0.1:${port}/?${query}`)
    await page
      .waitForFunction(() => !!globalThis.__c5, null, { timeout: 30000 })
      .catch(async (error) => {
        arm.startupDiagnostic = await page.evaluate(() => ({
          body: document.body.innerText,
          failure: globalThis.__rendererBenchFailure,
          startupError: globalThis.__c5StartupError,
          stage: globalThis.__c5Stage,
          workerOpenError: globalThis.__c5WorkerOpenError,
        }))
        throw error
      })
    arm.info = await page.evaluate(() => globalThis.__c5.info())
    qualifyHardware(arm.info)
    await page.bringToFront()
    await prepare(page)
    const browserSession = await browser.newBrowserCDPSession()
    const session = await context.newCDPSession(page)
    const phase = await tracePhase({
      page,
      session,
      browserSession,
      output,
      label: name,
      categories:
        'toplevel,devtools.timeline,blink.user_timing,cc,viz,gpu,disabled-by-default-devtools.timeline',
      operation: () => samples(page, name, arm),
      traced: true,
    })
    arm.tracePhase = phase
    assert(!phase.error, phase.error)
    assert(phase.trace, 'Trace artifact required')
    const trace = JSON.parse(gunzipSync(await readFile(join(output, phase.trace))))
    arm.latency = c5PresentationLatency(phase, trace.traceEvents)
    arm.sustained = await measureCpu(browserSession, () => sustained(page))
    arm.pageErrors = pageErrors
    arm.consoleMessages = consoleMessages
    assert.deepEqual(pageErrors, [], 'Browser errors during C5 arm')
    await context.close()
  } catch (error) {
    arm.errors.push(String(error))
    arm.pageErrors = pageErrors
    arm.consoleMessages = consoleMessages
    throw error
  } finally {
    await browser?.close()
    await writeReport()
  }
}

async function prepare(page) {
  await page.evaluate(() => {
    globalThis.__c5Keys = []
    document.addEventListener(
      'keydown',
      () => {
        globalThis.__c5KeyTime = performance.timeOrigin + performance.now()
      },
      true,
    )
    globalThis.__c5.terminal.onData(async ({ bytes: data }) => {
      const started = globalThis.__c5KeyTime
      await globalThis.__c5.markEcho()
      await globalThis.__c5.terminal.write(data)
      globalThis.__c5Keys.push({
        started,
        acknowledged: performance.timeOrigin + performance.now(),
      })
    })
    globalThis.__c5.terminal.focus()
  })
}

async function samples(page, name, arm) {
  const captures = []
  for (let index = 0; index < sampleCount; index += 1) {
    await page.evaluate(async () => {
      await globalThis.__c5.terminal.write('\x1b[H\x1b[2K')
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)
    })
    await pause(90)
    await page.keyboard.type('#')
    await page
      .waitForFunction(() => globalThis.__c5Keys.length > 0, null, { timeout: 3000 })
      .catch(async (error) => {
        arm.inputDiagnostic = await page.evaluate(() => ({
          activeElement: document.activeElement?.outerHTML,
          focused: document.hasFocus(),
          keyTime: globalThis.__c5KeyTime,
          diagnostics: globalThis.__c5.terminal.diagnostics,
          failure: globalThis.__rendererBenchFailure,
        }))
        throw error
      })
    const key = await page.evaluate(() => globalThis.__c5Keys.shift())
    await pause(70)
    const lines = await page.evaluate(() => globalThis.__c5.terminal.visibleLines())
    assert(
      lines.some((line) => line.includes('#')),
      'Echo missing from submitted text',
    )
    const image = await page.screenshot(
      index === 0 ? { path: join(output, `${name}-echo.png`) } : {},
    )
    const timestamp = await page.evaluate(() => performance.timeOrigin + performance.now())
    captures.push({
      operation: 'input',
      started: key.started,
      timestamp,
      acknowledgedMilliseconds: key.acknowledged - key.started,
      screenshotBytes: image.length,
      screenshotSha256: createHash('sha256').update(image).digest('hex'),
    })
    await pause(40 + ((index * 37) % 100))
  }
  await pause(100)
  return { captures }
}

async function sustained(page) {
  return page.evaluate(async (writes) => {
    const terminal = globalThis.__c5.terminal
    const before = await globalThis.__c5.metrics()
    let submittedFrames = 0
    const subscription = terminal.onFrame(() => {
      submittedFrames += 1
    })
    const payload = '0123456789abcdef'.repeat(1000) + '\r\n'
    const acknowledgements = []
    let maximumPending = 0
    let pending = 0
    for (let index = 0; index < writes; index += 1) {
      pending += 1
      maximumPending = Math.max(maximumPending, pending)
      const result = Promise.resolve(terminal.write(payload)).finally(() => {
        pending -= 1
      })
      acknowledgements.push(result)
      await new Promise((resolve) => setTimeout(resolve, 4))
    }
    await Promise.all(acknowledgements)
    await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
    subscription.dispose()
    const after = await globalThis.__c5.metrics()
    return {
      writes,
      bytes: new TextEncoder().encode(payload).byteLength * writes,
      submittedFrames,
      maximumPending,
      output: terminal.visibleLines().join('\n'),
      metrics: Object.fromEntries(
        Object.entries(after).map(([key, value]) => [key, value - (before[key] ?? 0)]),
      ),
    }
  }, sustainedWrites)
}

function qualifyHardware(info) {
  assert.equal(info.visibility, 'visible', 'Headed visible page required')
  assert.equal(info.dpr, 2, 'DPR 2 required')
  assert.equal(info.adapter?.fallback, false, 'Hardware adapter required')
  assert(!/swiftshader|software/i.test(info.adapter?.description ?? ''), 'Hardware GPU required')
}

async function buildSource(root) {
  const [bundle, worker, wasm, bridge, compose, font] = await Promise.all([
    build(root, '.internal/c5-idle-immediate/entry.mjs'),
    build(root, '.internal/c5-idle-immediate/worker.mjs'),
    readFile(join(root, 'ghostty-vt.wasm')),
    readFile(join(root, 'bridge.wasm')),
    readFile(join(root, 'canvas-compose.wasm')),
    readFile(
      join(
        root,
        'node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2',
      ),
    ),
  ])
  return {
    bundle,
    worker,
    files: new Map([
      ['/ghostty-vt.wasm', wasm],
      ['/bridge.wasm', bridge],
      ['/canvas-compose.wasm', compose],
      ['/font.woff2', font],
    ]),
    hashes: {
      bundle: createHash('sha256').update(bundle).digest('hex'),
      worker: createHash('sha256').update(worker).digest('hex'),
    },
  }
}

async function build(root, entry) {
  const result = await Bun.build({
    entrypoints: [join(root, entry)],
    target: 'browser',
    format: 'esm',
  })
  if (!result.success) throw new Error(`Build failed: ${join(root, entry)}`)
  return result.outputs[0].text()
}

async function writeReport() {
  await writeFile(join(output, 'c5-results.json'), JSON.stringify(report, null, 2))
}

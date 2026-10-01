import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { platform, release, arch, cpus } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { cpuSample, verifyHash, withDeadline } from './comparison-guards.mjs'
import { ink } from './comparison-pixels.mjs'
import { WebSocketServer } from 'ws'
import { markdown, order, quantile, summaries } from './comparison-report.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
const args = process.argv.slice(2)
const smoke = args.includes('--smoke')
const headless = smoke && !args.includes('--smoke-headed')
const value = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback)
const output = resolve(value('--output', join(root, smoke ? 'smoke' : 'results')))
const repetitions = Number(value('--repetitions', manifest.settings.repetitions))
assert(
  Number.isInteger(repetitions) && repetitions >= 3,
  'Measurements require at least three repetitions',
)
const smokeHistoryRows = Number(value('--smoke-history-rows', 64))
assert(
  Number.isInteger(smokeHistoryRows) &&
    smokeHistoryRows > 0 &&
    smokeHistoryRows <= manifest.settings.scrollback,
  'Smoke history rows must be within the scrollback limit',
)
const counts = smoke ? [Number(value('--smoke-count', 1))] : manifest.settings.counts
assert(
  counts.every((count) => manifest.settings.counts.includes(count)),
  'Terminal count must be 1, 8, or 17',
)
const variantIds = manifest.variants.map(({ id }) => id)
const s = manifest.settings
if (!smoke && platform() === 'darwin') {
  const power = execFileSync('/usr/bin/pmset', ['-g', 'batt'], { encoding: 'utf8' })
  assert(power.includes("'AC Power'"), 'waiting for the Mac to be plugged in')
}
await mkdir(output, { recursive: true })
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
const artifact = {
  schema: 1,
  manifest,
  smoke,
  repetitions: smoke ? 1 : repetitions,
  hardware: false,
  startedAt: new Date().toISOString(),
  environment: {},
  runs: [],
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

async function latency(page, session) {
  await page.evaluate(() => window.__compare.smokeMarker())
  await page.evaluate(() => window.__compare.connectEcho())
  const frames = await capturedFrames(session)
  const samples = { write: [], input: [], captures: [], captureStream: frames.events }
  try {
    for (let index = -2; index < s.latencySamples; index++) {
      const color = index % 2 ? 'red' : 'green'
      const started = await page.evaluate((color) => window.__compare.writeMarker(color), color)
      const shown = await frames.wait(color, started)
      if (index >= 0) {
        samples.write.push(shown.timestamp - started)
        samples.captures.push({ operation: 'write', started, ...shown })
      }
    }
    for (let index = -2; index < s.latencySamples; index++) {
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
    await page.goto(origin)
    await page.waitForFunction(() => Boolean(window.__compare))
    await page.evaluate((testCase) => window.__compare.initialize(testCase), testCase)
    run.parse = {}
    run.parserErrors = []
    for (const { name, bytes } of manifest.fixtures) {
      run.phase = `parser/${name}`
      const sample = await parserFixture(page, name, bytes)
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
  const run = { ...testCase, repetition, executionOrder: artifact.runs.length }
  const contexts = new Set()
  const remaining = smoke ? 120_000 : 30 * 60_000 - (Date.now() - Date.parse(artifact.startedAt))
  try {
    return await withDeadline(
      () => measureBody(testCase, repetition, browserSession, run, contexts),
      Math.min(120_000, remaining),
      () => {
        for (const context of contexts) void context.close().catch(() => {})
      },
    )
  } catch (error) {
    run.error = String(error.stack ?? error)
    return run
  }
}

async function measureBody(testCase, repetition, browserSession, run, contexts) {
  if (testCase.count === 1 || smoke) await parserOnly(testCase, run, contexts)
  run.phase = 'rendered/prepare'
  const context = await browser.newContext({ viewport: s.viewport, deviceScaleFactor: s.dpr })
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
    await page.goto(origin)
    await page.waitForFunction(() => Boolean(window.__compare))
    await page.bringToFront()
    const session = await context.newCDPSession(page)
    let empty
    if (!smoke) empty = await memory(page, session, browserSession)
    await page.evaluate((testCase) => window.__compare.prepare(testCase), testCase)
    const info = await page.evaluate(() => window.__compare.info())
    if (!smoke && testCase.variant === 'ghostty-webgpu')
      assert(info.adapter?.fallback === false, 'Software WebGPU adapter rejected')
    run.info = info
    if (!smoke) {
      const initial = await memory(page, session, browserSession)
      run.historyLengths = await page.evaluate(() => window.__compare.history())
      const history = await memory(page, session, browserSession)
      run.memory = { empty, initial, history }
    }
    run.correctness = await page.evaluate(() => window.__compare.correctness())
    const screenshot = `${testCase.variant}-${testCase.path}-${testCase.count}.png`
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
      run.status = 'correctness-only'
      return run
    }
    run.refreshPeriod = quantile(await page.evaluate(() => window.__compare.refreshPeriod()), 0.5)
    const before = await processCpu(browserSession)
    const idleStarted = performance.now()
    await page.waitForTimeout(s.idleMilliseconds)
    const idleMs = performance.now() - idleStarted
    run.idle = {
      milliseconds: idleMs,
      cpu: cpuSample(before, await processCpu(browserSession), idleMs),
    }
    run.phase = 'captured-frame latency'
    run.latency = await latency(page, session)
    run.burst = {}
    for (const { name } of manifest.fixtures) {
      run.phase = `burst/${name}/warmup`
      await page.evaluate((name) => window.__compare.burst(name, 3), name)
      run.phase = `burst/${name}/measured`
      run.burst[name] = await page.evaluate(
        ({ name, frames }) => window.__compare.burst(name, frames),
        { name, frames: s.burstFrames },
      )
    }
    run.phase = 'output/ascii'
    const beforeOutput = await processCpu(browserSession)
    const outputStarted = performance.now()
    const outputSample = await page.evaluate(
      (frames) => window.__compare.burst('ascii', frames),
      s.outputFrames,
    )
    const outputMs = performance.now() - outputStarted
    run.output = {
      ...outputSample,
      cpu: cpuSample(beforeOutput, await processCpu(browserSession), outputMs),
      memory: await memory(page, session, browserSession),
    }
    assert.deepEqual(errors, [])
    return run
  } catch (error) {
    run.error = String(error.stack ?? error)
    run.pageErrors = errors
    if (error.captureData) {
      run.captureFailure = error.captureMetadata
      await writeFile(
        join(
          output,
          `capture-failure-${testCase.variant}-${testCase.path}-${testCase.count}-${repetition}.png`,
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
          `failure-${testCase.variant}-${testCase.path}-${testCase.count}-${repetition}.png`,
        ),
      })
      .catch(() => {})
    return run
  } finally {
    await context.close()
    contexts.delete(context)
  }
}

try {
  browser = await chromium.launch({
    channel: smoke && platform() === 'linux' ? undefined : 'chromium',
    headless,
    args: browserArgs,
    env: launchEnv,
  })
  const browserSession = await browser.newBrowserCDPSession()
  const gpu = await browserSession.send('SystemInfo.getInfo')
  artifact.hardware = !smoke && !/unknown|swiftshader|llvmpipe|software/i.test(renderer(gpu))
  assert(smoke || artifact.hardware, 'Headed hardware GPU required for measurements')
  artifact.environment = {
    browser: browser.version(),
    os: `${platform()} ${release()} ${arch()}`,
    cpu: cpus()[0]?.model,
    renderer: renderer(gpu),
    gpu,
    headed: !headless,
    launchArguments: browserArgs,
    power:
      platform() === 'darwin'
        ? execFileSync('/usr/bin/pmset', ['-g', 'batt'], { encoding: 'utf8' })
        : null,
  }
  for (let repetition = 0; repetition < artifact.repetitions; repetition++) {
    const paths = repetition % 2 ? ['string', 'bytes'] : ['bytes', 'string']
    const cases = order(variantIds, repetition).flatMap((variant) =>
      paths.flatMap((path) => counts.map((count) => ({ variant, path, count }))),
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
        smoke || Date.now() - Date.parse(artifact.startedAt) < 30 * 60_000,
        '30-minute measurement window expired',
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
  if (!smoke) {
    artifact.summary = summaries(artifact)
    await writeFile(join(output, 'benchmarks.md'), markdown(artifact))
  }
} finally {
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2) + '\n')
  await browser?.close()
  echo.close()
  await new Promise((resolve) => server.close(resolve))
}
console.log(`Artifact: ${artifactPath}`)
if (artifact.runs.some((run) => run.error || run.parserErrors?.length)) process.exitCode = 1

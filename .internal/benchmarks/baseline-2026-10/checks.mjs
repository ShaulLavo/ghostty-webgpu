import { chromium } from 'playwright'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
const { tracePhase } = await import(pathToFileURL(resolve('scripts/comparison-trace.mjs')).href)
const { presentationLatency } = await import(
  pathToFileURL(resolve('scripts/comparison-latency.mjs')).href
)

const host = process.platform === 'darwin' ? 'mac' : 'pc'
const out = resolve(process.env.P0A_OUTPUT ?? 'results')
await mkdir(out, { recursive: true })
async function build(entry) {
  const result = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm' })
  if (!result.success) throw new Error(`Build failed: ${entry}`)
  return result.outputs[0].text()
}
const files = new Map(
  await Promise.all(
    ['ghostty-vt.wasm', 'bridge.wasm', 'canvas-compose.wasm'].map(async (name) => [
      `/${name}`,
      await readFile(name),
    ]),
  ),
)
files.set(
  '/font.woff2',
  await readFile(
    'node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2',
  ),
)
files.set('/bundle.js', await build('bench/renderer-benchmark-entry.ts'))
files.set('/diagnostic-worker.js', await build('bench/renderer-diagnostic-worker.mjs'))
await writeFile(`${out}/${host}-checks.bundle.js`, files.get('/bundle.js'))
await writeFile(`${out}/${host}-checks.worker.js`, files.get('/diagnostic-worker.js'))
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 41878,
  fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/')
      return new Response(
        '<!doctype html><style>body{margin:0;background:black}main{width:1580px;height:900px}</style><main></main><script type="module" src="/bundle.js"></script>',
        { headers: { 'content-type': 'text/html' } },
      )
    if (!files.has(path)) return new Response('', { status: 404 })
    return new Response(files.get(path), {
      headers: {
        'content-type': path.endsWith('.js') ? 'text/javascript' : 'application/octet-stream',
      },
    })
  },
})
const pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))
let browser
const report = { cases: [], errors: [] }
async function prepare(page) {
  await page.evaluate(() => {
    const debug = globalThis.__p0aHosted
    const terminal = debug.terminal
    globalThis.__compare = { traceBegin: () => debug.begin(), traceEnd: () => debug.end() }
    globalThis.__p0aKeys = []
    document.addEventListener(
      'keydown',
      () => {
        globalThis.__p0aKeyTime = performance.timeOrigin + performance.now()
      },
      true,
    )
    terminal.onData(async (data) => {
      const started = globalThis.__p0aKeyTime
      await debug.markEcho()
      await terminal.write(data)
      globalThis.__p0aKeys.push({
        started,
        acknowledged: performance.timeOrigin + performance.now(),
      })
    })
    terminal.focus()
  })
}
async function samples(page) {
  const captures = []
  const acknowledgements = []
  for (let index = 0; index < 6; index++) {
    await page.evaluate(async () => {
      await globalThis.__p0aHosted.terminal.write('\x1b[H\x1b[2K')
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)
    })
    await page.keyboard.press('#')
    await page.waitForFunction(() => globalThis.__p0aKeys.length > 0)
    const key = await page.evaluate(() => globalThis.__p0aKeys.shift())
    await pause(80)
    const lines = await page.evaluate(() => globalThis.__p0aHosted.terminal.visibleLines())
    if (!lines.some((line) => line.includes('#')))
      throw new Error('Echo missing from submitted text')
    const image = await page.screenshot()
    const timestamp = await page.evaluate(() => performance.timeOrigin + performance.now())
    captures.push({
      operation: 'input',
      started: key.started,
      timestamp,
      screenshotBytes: image.length,
    })
    acknowledgements.push(key.acknowledged - key.started)
  }
  await pause(100)
  return { captures, acknowledgements }
}
async function latency(page, session, browserSession, label) {
  const phase = await tracePhase({
    page,
    session,
    browserSession,
    output: out,
    label,
    categories:
      'toplevel,devtools.timeline,blink.user_timing,cc,viz,gpu,disabled-by-default-devtools.timeline',
    operation: () => samples(page),
    traced: true,
  })
  const trace = JSON.parse(gunzipSync(await readFile(join(out, phase.trace))))
  try {
    return { phase, presentation: presentationLatency(phase, trace.traceEvents) }
  } catch (error) {
    return {
      phase,
      presentationBlocker: String(error),
      presentationEventCount: trace.traceEvents.filter(
        (event) => event.name === 'AnimationFrame::Presentation',
      ).length,
    }
  }
}
async function recover(page, kind) {
  await page.evaluate(async (kind) => {
    const debug = globalThis.__p0aHosted
    const before = await debug.snapshot()
    const state = { kind, before, start: performance.now() }
    globalThis.__p0aRecovery = state
    const subscription = debug.terminal.onFrame(() => {
      state.submittedMilliseconds = performance.now() - state.start
      subscription.dispose()
    })
    if (kind === 'font') state.operation = await debug.terminal.setFont({ size: 14 })
    if (kind === 'loss') state.operation = await debug.lose()
  }, kind)
  await page.waitForFunction(
    () => globalThis.__p0aRecovery.submittedMilliseconds !== undefined,
    null,
    { timeout: 10000 },
  )
  return page.evaluate(async () => ({
    ...globalThis.__p0aRecovery,
    after: await globalThis.__p0aHosted.snapshot(),
  }))
}
async function backlog(page) {
  await page.evaluate(() => {
    const terminal = globalThis.__p0aHosted.terminal
    globalThis.__p0aBacklog = {
      sent: 0,
      acknowledged: 0,
      maxPending: 0,
      pending: 0,
      ackMilliseconds: [],
    }
    const payload = '0123456789abcdef'.repeat(1000) + '\r\n'
    globalThis.__p0aTimer = setInterval(() => {
      const state = globalThis.__p0aBacklog
      state.sent++
      state.pending++
      state.maxPending = Math.max(state.maxPending, state.pending)
      const started = performance.now()
      Promise.resolve(terminal.write(payload)).then(() => {
        state.pending--
        state.acknowledged++
        state.ackMilliseconds.push(performance.now() - started)
      })
    }, 4)
  })
  const keys = []
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press('#')
    await pause(100)
    keys.push(await page.evaluate(() => globalThis.__p0aKeys.shift() ?? null))
  }
  await page.evaluate(() => clearInterval(globalThis.__p0aTimer))
  await pause(500)
  return page.evaluate((keys) => ({ ...globalThis.__p0aBacklog, keys }), keys)
}
async function runCase(worker, index) {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
  })
  const page = await context.newPage()
  const result = { worker, index, errors: [] }
  report.cases.push(result)
  try {
    await page.goto(
      `http://127.0.0.1:41878/?hosted&trace&backend=webgpu&columns=200&rows=50&defaultGpu${worker ? '&worker' : ''}`,
    )
    await page.waitForFunction(() => !!globalThis.__rendererBench, { timeout: 30000 })
    result.info = await page.evaluate(() => globalThis.__rendererBench.getPageInfo())
    if (result.info.adapter?.fallback !== false) throw new Error('Hardware WebGPU adapter required')
    await prepare(page)
    const session = await context.newCDPSession(page)
    result.latency = await latency(
      page,
      session,
      await browser.newBrowserCDPSession(),
      `${host}-input-${index}-worker-${worker}`,
    )
    result.backlog = await backlog(page)
    result.font = await recover(page, 'font')
    result.workerHeaps = await workerHeaps(await browser.newBrowserCDPSession())
    result.heapBeforeLoss = await session.send('Runtime.getHeapUsage')
    result.loss = await recover(page, 'loss')
    result.heapAfterLoss = await session.send('Runtime.getHeapUsage')
  } catch (error) {
    result.errors.push(String(error))
  } finally {
    await context.close()
    await writeFile(`${out}/${host}-checks.json`, JSON.stringify(report, null, 2))
  }
}
try {
  if (host === 'pc') {
    report.vramBeforeMiB = Number(
      execFileSync('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], {
        encoding: 'utf8',
      }).trim(),
    )
    if (report.vramBeforeMiB < 2048) throw new Error('Less than 2 GiB free VRAM')
  }
  browser = await chromium.launch({
    channel: 'chromium',
    headless: false,
    args: ['--enable-unsafe-webgpu'].concat(
      process.platform === 'linux' ? ['--ozone-platform=wayland'] : [],
    ),
  })
  report.browser = browser.version()
  let index = 0
  for (const worker of [0, 1, 1, 0]) await runCase(worker, index++)
} catch (error) {
  report.errors.push(String(error))
} finally {
  await writeFile(`${out}/${host}-checks.json`, JSON.stringify(report, null, 2))
  await browser?.close()
  server.stop(true)
}

async function workerHeaps(session) {
  const { targetInfos } = await session.send('Target.getTargets')
  const heaps = []
  for (const target of targetInfos.filter((entry) => entry.type === 'worker')) {
    try {
      heaps.push({ target, heap: await targetHeap(session, target.targetId) })
    } catch (error) {
      heaps.push({ target, error: String(error) })
    }
  }
  return heaps
}
function responseFromTarget(session, sessionId) {
  let timer
  let listener
  const promise = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Worker heap timeout')), 5000)
    listener = (event) => resolveTargetMessage(event, sessionId, resolve)
    session.on('Target.receivedMessageFromTarget', listener)
  })
  return {
    promise,
    close: () => {
      clearTimeout(timer)
      session.off('Target.receivedMessageFromTarget', listener)
    },
  }
}
function resolveTargetMessage(event, sessionId, resolve) {
  if (event.sessionId !== sessionId) return
  const message = JSON.parse(event.message)
  if (message.id === 501) resolve(message)
}
async function targetHeap(session, targetId) {
  const { sessionId } = await session.send('Target.attachToTarget', { targetId, flatten: false })
  const response = responseFromTarget(session, sessionId)
  try {
    await session.send('Target.sendMessageToTarget', {
      sessionId,
      message: JSON.stringify({ id: 501, method: 'Runtime.getHeapUsage' }),
    })
    return await response.promise
  } finally {
    response.close()
    await session.send('Target.detachFromTarget', { sessionId })
  }
}

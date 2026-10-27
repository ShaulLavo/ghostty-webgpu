import { chromium } from 'playwright'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
const host = process.platform === 'darwin' ? 'mac' : 'pc'
const out = resolve(process.env.P0A_OUTPUT ?? 'results')
const runPrefix = `${host}-${process.env.P0A_REVIEW_RUN ?? ''}`
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
await writeFile(`${out}/${runPrefix}review.bundle.js`, files.get('/bundle.js'))
await writeFile(`${out}/${runPrefix}review.worker.js`, files.get('/diagnostic-worker.js'))
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 41881,
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
function browserPortMessage({ data }) {
  const state = globalThis.__p0aReview
  if (data.type === 'ready') return state.readyResolve(data)
  if (data.type !== 'output-ack')
    return state.pendingReject(new Error(`Unexpected producer message: ${data.type}`))
  if (data.sequence !== state.sequence)
    return state.pendingReject(new Error('Producer acknowledgement sequence mismatch'))
  state.pendingResolve(data.sequence)
}
async function browserPrepare() {
  const state = { sequence: 0, port: null }
  globalThis.__p0aReview = state
  const channel = new MessageChannel()
  state.port = channel.port1
  const ready = new Promise((resolve) => {
    state.readyResolve = resolve
  })
  channel.port1.onmessage = browserPortMessage
  channel.port1.start()
  await globalThis.__p0aHosted.terminal.attachOutputPort(channel.port2)
  state.identity = await ready
}
async function browserSend(bytes, mode) {
  const state = globalThis.__p0aReview
  let timer
  const acknowledged = new Promise((resolve, reject) => {
    state.pendingResolve = resolve
    state.pendingReject = reject
    timer = setTimeout(() => reject(new Error('Producer acknowledgement timeout')), 5000)
  })
  state.sequence++
  const message = { ...state.identity, type: 'output', sequence: state.sequence, data: bytes }
  const start = performance.now()
  state.port.postMessage(message, mode === 'transfer' ? [bytes.buffer] : [])
  const postMilliseconds = performance.now() - start
  const senderByteLength = bytes.byteLength
  let sequence
  try {
    sequence = await acknowledged
  } finally {
    clearTimeout(timer)
  }
  const acknowledgementMilliseconds = performance.now() - start
  await new Promise(requestAnimationFrame)
  await new Promise(requestAnimationFrame)
  return { sequence, postMilliseconds, senderByteLength, acknowledgementMilliseconds }
}
async function browserBatch({ mode, byteLength, updates }) {
  const template = new Uint8Array(byteLength)
  const pattern = new TextEncoder().encode('0123456789abcdef\r\n')
  for (let index = 0; index < byteLength; index++) template[index] = pattern[index % pattern.length]
  const buffers = Array.from({ length: updates }, () => new Uint8Array(template))
  for (let index = 0; index < 4; index++) await browserSend(new Uint8Array(template), mode)
  const debug = globalThis.__p0aHosted
  await debug.begin()
  const before = await debug.snapshot()
  const start = performance.now()
  const observations = []
  for (const buffer of buffers) observations.push(await browserSend(buffer, mode))
  const elapsedMilliseconds = performance.now() - start
  const trace = await debug.end()
  const after = await debug.snapshot()
  const output = debug.terminal.visibleLines().join('\n')
  globalThis.__p0aReview.port.close()
  return {
    mode,
    byteLength,
    updates,
    warmupUpdates: 4,
    observations,
    elapsedMilliseconds,
    before,
    after,
    trace,
    output,
  }
}
async function browserRecover() {
  const debug = globalThis.__p0aHosted
  const before = await debug.snapshot()
  let resolveFrame
  const frame = new Promise((resolve) => {
    resolveFrame = resolve
  })
  const started = performance.now()
  const subscription = debug.terminal.onFrame(() => {
    subscription.dispose()
    resolveFrame(performance.now() - started)
  })
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Recovery frame timeout')), 10000)
  })
  try {
    const trigger = await debug.lose()
    const during = await debug.snapshot()
    const submittedMilliseconds = await Promise.race([frame, timeout])
    return {
      before,
      during,
      after: await debug.snapshot(),
      trigger,
      submittedMilliseconds,
      output: debug.terminal.visibleLines().join('\n'),
    }
  } finally {
    clearTimeout(timer)
  }
}
const browserHelpers = [
  browserPortMessage,
  browserPrepare,
  browserSend,
  browserBatch,
  browserRecover,
]
  .map((fn) => fn.toString())
  .join('\n')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const phases = (process.env.P0A_REVIEW_PHASES ?? 'transport,recovery').split(',')
if (phases.some((phase) => !['transport', 'recovery'].includes(phase)))
  throw new Error('Unknown review probe phase')
const report = {
  phases,
  schema: 1,
  sourceHead:
    process.env.P0A_SOURCE_HEAD ??
    Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim(),
  runtimeRevision: 'd2ed8989a745f016188e0a2e749009b3e1450f33',
  host,
  grid: { columns: 200, rows: 50, dpr: 2 },
  bundleFiles: { main: `${runPrefix}review.bundle.js`, worker: `${runPrefix}review.worker.js` },
  bundleHashes: {
    main: hash(files.get('/bundle.js')),
    worker: hash(files.get('/diagnostic-worker.js')),
  },
  wasmHashes: Object.fromEntries(
    ['ghostty-vt.wasm', 'bridge.wasm', 'canvas-compose.wasm'].map((name) => [
      name,
      hash(files.get(`/${name}`)),
    ]),
  ),
  transport: [],
  recovery: [],
  errors: [],
}
let browser
async function save() {
  await writeFile(
    `${out}/${host}-${process.env.P0A_REVIEW_RUN ?? ''}channels.json`,
    JSON.stringify(report, null, 2) + '\n',
  )
}
async function runCase(backend, worker, operation) {
  if (host === 'pc') {
    const free = Number(
      execFileSync('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], {
        encoding: 'utf8',
      }).trim(),
    )
    report.vramBeforeWindows ??= []
    report.vramBeforeWindows.push({ backend, worker, freeMiB: free })
    if (free < 2048) throw new Error('Less than 2 GiB free VRAM before headed page')
  }
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
  })
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  try {
    await page.goto(
      `http://127.0.0.1:41881/?hosted&trace&backend=${backend}&columns=200&rows=50&defaultGpu${worker ? '&worker' : ''}`,
    )
    await page.waitForFunction(() => !!globalThis.__rendererBench, null, { timeout: 30000 })
    await page.bringToFront()
    const info = await page.evaluate(() => globalThis.__rendererBench.getPageInfo())
    if (backend === 'webgpu' && info.adapter?.fallback !== false)
      throw new Error('Hardware WebGPU required')
    const diagnostic = await page.evaluate(() => globalThis.__p0aHosted.snapshot())
    if (
      backend === 'webgl2' &&
      (!diagnostic.snapshot.gpu.renderer ||
        /swiftshader|llvmpipe|software/i.test(diagnostic.snapshot.gpu.renderer))
    )
      throw new Error('Hardware WebGL2 required')
    await page.addScriptTag({ content: browserHelpers })
    return await operation(page, info)
  } finally {
    await context.close()
  }
}
async function measureTransport(page, info, options) {
  await page.evaluate(browserPrepare)
  const result = await page.evaluate(browserBatch, options)
  const { output, ...observations } = result
  return { info, ...observations, outputSha256: hash(output) }
}
async function measureRecovery(page, info) {
  const result = await page.evaluate(browserRecover)
  const { output, ...observations } = result
  return { info, ...observations, outputSha256: hash(output) }
}
async function transportCase(backend, mode, byteLength, order) {
  const record = { backend, mode, byteLength, order, worker: true }
  report.transport.push(record)
  try {
    const options = { mode, byteLength, updates: 24 }
    Object.assign(
      record,
      await runCase(backend, true, (page, info) => measureTransport(page, info, options)),
    )
  } catch (error) {
    record.error = String(error)
  }
  await save()
}
async function recoveryCase(backend, worker) {
  const record = { backend, worker }
  report.recovery.push(record)
  try {
    Object.assign(record, await runCase(backend, worker, measureRecovery))
  } catch (error) {
    record.error = String(error)
  }
  await save()
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
    args: ['--enable-unsafe-webgpu'].concat(host === 'pc' ? ['--ozone-platform=wayland'] : []),
  })
  const session = await browser.newBrowserCDPSession()
  report.browser = browser.version()
  report.gpuInfo = await session.send('SystemInfo.getInfo')
  if (phases.includes('transport')) await runTransportCohort()
  if (phases.includes('recovery')) await runRecoveryCohort()
} catch (error) {
  report.errors.push(String(error))
} finally {
  await save()
  await browser?.close()
  server.stop(true)
}

async function runTransportCohort() {
  for (const backend of ['webgpu', 'webgl2']) await transportBackend(backend)
}
async function transportBackend(backend) {
  for (const byteLength of [4096, 65536, 1048576]) await transportSize(backend, byteLength)
}
async function transportSize(backend, byteLength) {
  let order = 0
  for (const mode of ['clone', 'transfer', 'transfer', 'clone'])
    await transportCase(backend, mode, byteLength, order++)
}
async function runRecoveryCohort() {
  for (const backend of ['webgpu', 'webgl2']) {
    for (const worker of [false, true]) await recoveryCase(backend, worker)
  }
}

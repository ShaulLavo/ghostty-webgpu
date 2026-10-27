import { chromium } from 'playwright'
import { readFile, writeFile } from 'node:fs/promises'
import { execFileSync, spawn } from 'node:child_process'
import { resolve } from 'node:path'

const out = resolve('results')
const built = await Bun.build({
  entrypoints: ['bench/renderer-benchmark-entry.ts'],
  target: 'browser',
  format: 'esm',
})
if (!built.success) throw new Error('M5 benchmark bundle failed')
const bundle = await built.outputs[0].text()
await writeFile(`${out}/mac-m5.bundle.js`, bundle)
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
files.set('/bundle.js', bundle)
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 41877,
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
let browser
let browserProcess
let originalMode
const evidence = { observations: [], errors: [] }
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
async function state(page) {
  return page.evaluate(async () => {
    const { terminal, renderer } = globalThis.__p0aHosted
    const canvas = document.querySelector('canvas')
    return {
      visibility: document.visibilityState,
      dpr: devicePixelRatio,
      metrics: { ...renderer.metrics },
      lines: await terminal.readLines(
        Math.max(0, (await terminal.lineCount()) - 50),
        await terminal.lineCount(),
      ),
      visible: terminal.visibleLines(),
      fontRatio: renderer.font.pixelRatio,
      canvas: { width: canvas.width, height: canvas.height },
      screen: { width: screen.width, height: screen.height },
    }
  })
}
async function checkBackend(context, backend, lowResolution) {
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  await page.bringToFront()
  await page.goto(
    `http://127.0.0.1:41877/?hosted&backend=${backend}&columns=200&rows=50&defaultGpu`,
    { waitUntil: 'commit' },
  )
  await page.bringToFront()
  await page.waitForFunction(() => !!globalThis.__rendererBench, null, {
    polling: 100,
    timeout: 15000,
  })
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  await page.bringToFront()
  await pause(500)
  const before = await state(page)
  await page.screenshot({ path: `${out}/mac-m5-${backend}-before.png` })
  const cover = await context.newPage()
  await cover.setContent(
    '<!doctype html><h1>Real background-tab check</h1><p>The benchmark terminal is in the other tab.</p>',
  )
  await (
    await context.newCDPSession(cover)
  ).send('Emulation.setFocusEmulationEnabled', { enabled: false })
  await cover.bringToFront()
  await pause(500)
  const hiddenBefore = await state(page)
  await page.evaluate(async () => {
    const { terminal } = globalThis.__p0aHosted
    for (let index = 0; index < 20; index++) await terminal.write(`\x1b[Hhidden-${index}-parsed`)
  })
  await pause(1000)
  const hiddenAfter = await state(page)
  await cover.screenshot({ path: `${out}/mac-m5-${backend}-background.png` })
  await page.bringToFront()
  await pause(500)
  const returned = await state(page)
  await page.screenshot({ path: `${out}/mac-m5-${backend}-returned.png` })
  const result = { backend, before, hiddenBefore, hiddenAfter, returned }
  evidence.observations.push(result)
  if (lowResolution) {
    try {
      execFileSync('./display-modes', [String(lowResolution.id)])
      await pause(1500)
      result.changedDisplay = await state(page)
      await page.screenshot({ path: `${out}/mac-m5-${backend}-display-changed.png` })
    } finally {
      execFileSync('./display-modes', [String(originalMode)])
      await pause(1000)
      result.restoredDisplay = await state(page)
    }
  }
  await page.evaluate(() => globalThis.__rendererBench.dispose())
  await cover.close()
  await page.close()
}
try {
  evidence.displayModes = JSON.parse(execFileSync('./display-modes', { encoding: 'utf8' }))
  originalMode = evidence.displayModes.current
  const lowResolution = evidence.displayModes.modes.find(
    (mode) => mode.width === mode.pixelWidth && mode.width >= 1280 && mode.id !== originalMode,
  )
  evidence.selectedMode = lowResolution ?? null
  browserProcess = spawn(
    chromium.executablePath(),
    [
      '--remote-debugging-port=41879',
      `--user-data-dir=${resolve('m5-native-profile')}`,
      '--enable-unsafe-webgpu',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch('http://127.0.0.1:41879/json/version')).ok) break
    } catch {}
    await pause(100)
  }
  browser = await chromium.connectOverCDP('http://127.0.0.1:41879', {
    noDefaults: true,
    isLocal: true,
  })
  evidence.browser = browser.version()
  evidence.automation = 'native Chromium + connectOverCDP(noDefaults:true), no context emulation'
  const context = browser.contexts()[0]
  for (const backend of ['webgpu', 'webgl2']) await checkBackend(context, backend, lowResolution)
} catch (error) {
  evidence.errors.push(String(error))
  process.exitCode = 1
} finally {
  if (originalMode) execFileSync('./display-modes', [String(originalMode)])
  await writeFile(`${out}/mac-m5.json`, JSON.stringify(evidence, null, 2))
  await browser?.close()
  browserProcess?.kill('SIGTERM')
  if (browserProcess) await pause(500)
  if (browserProcess?.exitCode === null) browserProcess.kill('SIGKILL')
  server.stop(true)
}

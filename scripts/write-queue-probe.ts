import { queueProbeInputCount } from '../bench/write-queue-input.js'
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { chromium, type Route } from 'playwright'
import { inspectQueueProbe, type QueueProbeResult } from '../bench/write-queue-probe.js'
import { swiftShaderArgs, swiftShaderEnv } from './swiftshader-launch.mjs'

const output = resolve(process.env.QUEUE_PROBE_OUTPUT ?? '.artifacts/write-queue-probe.json')
const root = resolve(import.meta.dirname, '..')
const hardware = process.env.GHOSTTY_BROWSER_HARDWARE === '1'
const origin = 'http://queue-probe.localhost'
const rates = [
  { intervalMs: 16, writesPerTick: 1 },
  { intervalMs: 4, writesPerTick: 1 },
  { intervalMs: 4, writesPerTick: 4 },
  { intervalMs: 1, writesPerTick: 128 },
]

async function bundle(path: string): Promise<string> {
  const result = await Bun.build({ entrypoints: [resolve(root, path)], target: 'browser' })
  assert(result.success, result.logs.map(String).join('\n'))
  assert.equal(result.outputs.length, 1)
  return result.outputs[0]!.text()
}

const resources = new Map([
  [
    '/probe.js',
    { body: await bundle('bench/write-queue-probe-entry.ts'), contentType: 'text/javascript' },
  ],
  [
    '/probe-worker.js',
    { body: await bundle('bench/write-queue-probe-worker.ts'), contentType: 'text/javascript' },
  ],
  [
    '/font.woff2',
    {
      body: await readFile(
        resolve(
          root,
          'node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2',
        ),
      ),
      contentType: 'font/woff2',
    },
  ],
  [
    '/ghostty-vt.wasm',
    { body: await readFile(resolve(root, 'ghostty-vt.wasm')), contentType: 'application/wasm' },
  ],
  [
    '/bridge.wasm',
    { body: await readFile(resolve(root, 'bridge.wasm')), contentType: 'application/wasm' },
  ],
])
const args = ['--enable-unsafe-webgpu']
if (!hardware) args.push(...swiftShaderArgs)
if (hardware && process.platform === 'linux' && process.env.WAYLAND_DISPLAY)
  args.push('--ozone-platform=wayland')
const browser = await chromium.launch({
  headless: !hardware,
  channel: hardware ? 'chromium' : undefined,
  args,
  env: hardware ? undefined : swiftShaderEnv(),
})
const runs: Array<{
  realm: string
  result: QueueProbeResult
  analysis: ReturnType<typeof inspectQueueProbe>
}> = []
const errors: string[] = []
const artifact = {
  source: Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root }).stdout.toString().trim(),
  host: process.platform,
  browser: browser.version(),
  hardware,
  geometry: {
    columns: 200,
    rows: 50,
    deviceScaleFactor: 2,
    dprKind: 'emulated context setting, not a real display transition',
  },
  queue: { maxBytes: 8 * 1024 * 1024, timeBudgetMs: 4 },
  endpoint:
    'Native DSR parse receipts, write promise acknowledgement, actual GPUQueue.submit calls. No presentation endpoint.',
  bounds: '750 ms production or 64 MiB attempted per rate, 8 MiB queue, 15 s drain deadline.',
  rates,
  runs,
  errors,
  gpu: {},
}
const deadline = setTimeout(() => {
  artifact.errors.push('Probe exceeded the 120 second wall bound')
  void browser.close()
}, 120_000)

async function serveResource(route: Route): Promise<void> {
  const resource = resources.get(new URL(route.request().url()).pathname)
  if (resource) {
    await route.fulfill(resource)
    return
  }
  await route.fulfill({
    contentType: 'text/html',
    body: '<main style="width:1500px;height:1000px"></main><script type="module" src="/probe.js"></script>',
  })
}

async function measure(realm: string, rate: (typeof rates)[number]): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1200 },
    deviceScaleFactor: 2,
  })
  try {
    await context.route(`${origin}/**`, serveResource)
    const page = await context.newPage()
    page.setDefaultTimeout(25_000)
    page.on('pageerror', (cause) => artifact.errors.push(String(cause)))
    await page.goto(`${origin}/?realm=${realm}`)
    await page.waitForFunction(() => Boolean(window.__queueProbe))
    const resultPromise = page.evaluate(
      ({ intervalMs, writesPerTick }) => window.__queueProbe.run(intervalMs, writesPerTick),
      rate,
    )
    await page.waitForFunction(() => window.__queueProbe.running())
    for (let index = 0; index < queueProbeInputCount; index += 1) {
      await page.keyboard.press('z')
      await page.waitForTimeout(40)
    }
    const result = await resultPromise
    const analysis = inspectQueueProbe(result)
    runs.push({ realm, result, analysis })
    console.log(
      JSON.stringify({
        realm,
        ...rate,
        final: result.final,
        pendingPeak: result.pendingPeak,
        analysis,
      }),
    )
    await page.evaluate(() => window.__queueProbe.dispose())
  } finally {
    await context.close()
  }
}

try {
  const cdp = await browser.newBrowserCDPSession()
  artifact.gpu = await cdp.send('SystemInfo.getInfo')
  for (const realm of ['main', 'worker']) for (const rate of rates) await measure(realm, rate)
} catch (cause) {
  artifact.errors.push(String(cause))
  throw cause
} finally {
  clearTimeout(deadline)
  await browser.close()
  await mkdir(dirname(output), { recursive: true })
  await Bun.write(output, JSON.stringify(artifact, null, 2) + '\n')
}
assert.equal(artifact.errors.length, 0, artifact.errors.join('\n'))
assert(
  runs.every(({ analysis }) => analysis.issues.length === 0),
  'Probe controls failed',
)
for (const realm of ['main', 'worker'])
  assert(
    runs.some((run) => run.realm === realm && run.analysis.backlogObserved),
    `${realm} did not grow a backlog`,
  )

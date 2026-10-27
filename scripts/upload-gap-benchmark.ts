import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { chromium } from 'playwright'

const output = resolve(process.env.BENCH_OUTPUT ?? '.artifacts/upload-gaps.json')
const bundle = await Bun.build({
  entrypoints: ['bench/upload-gap-entry.ts'],
  target: 'browser',
  format: 'esm',
})
assert(bundle.success)
const source = await bundle.outputs[0]!.text()
const args = [
  '--enable-unsafe-webgpu',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
]
if (process.platform === 'linux' && process.env.WAYLAND_DISPLAY)
  args.push('--ozone-platform=wayland')
const browser = await chromium.launch({ channel: 'chromium', headless: false, args })
try {
  const session = await browser.newBrowserCDPSession()
  const gpu = await session.send('SystemInfo.getInfo')
  const page = await browser.newPage()
  await page.route('http://localhost:41798/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><body>Upload gap calibration</body>',
    }),
  )
  await page.goto('http://localhost:41798/')
  await page.addScriptTag({
    type: 'module',
    content: source + '\nwindow.createSweep = createSweep;',
  })
  await page.waitForFunction(() => 'createSweep' in window)
  const results = []
  for (const backend of ['webgpu', 'webgl2']) {
    const adapter = await page.evaluate(async (backend) => {
      const factory = Reflect.get(window, 'createSweep')
      const sweep = await factory(backend)
      Reflect.set(window, 'uploadSweep', sweep)
      return sweep.adapter
    }, backend)
    const samples = []
    for (let repetition = 0; repetition < 5; repetition += 1)
      samples.push(...(await repetitionSamples(repetition)))
    await page.evaluate(() => Reflect.get(window, 'uploadSweep').dispose())
    results.push({ backend, adapter, samples })
  }
  async function repetitionSamples(repetition: number) {
    const samples = []
    for (const gap of [
      0, 256, 1024, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576, 1599872,
    ]) {
      const order = repetition % 2 === 0 ? ['bound', 'split'] : ['split', 'bound']
      for (const mode of order) samples.push(await sample(gap, mode, repetition))
    }
    return samples
  }
  async function sample(gap: number, mode: string, repetition: number) {
    const before = await session.send('SystemInfo.getProcessInfo')
    const result = await page.evaluate(
      ({ gap, mode }) => Reflect.get(window, 'uploadSweep').measure(gap, mode),
      { gap, mode },
    )
    const after = await session.send('SystemInfo.getProcessInfo')
    const cpuSeconds = after.processInfo.reduce(
      (sum, process) =>
        sum +
        Math.max(
          0,
          process.cpuTime -
            (before.processInfo.find((prior) => prior.id === process.id)?.cpuTime ??
              process.cpuTime),
        ),
      0,
    )
    return { gap, repetition, ...result, cpuSeconds }
  }
  await mkdir(dirname(output), { recursive: true })
  await Bun.write(
    output,
    JSON.stringify(
      { host: process.platform, browser: browser.version(), gpu, args, results },
      null,
      2,
    ) + '\n',
  )
} finally {
  await browser.close()
}

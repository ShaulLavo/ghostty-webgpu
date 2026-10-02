import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'

// NOT-PORTABLE: Site proof relies on surrounding Playwright install and external serving.
const url = process.argv[2]
const directory = process.argv[3]
if (!url || !directory) throw new TypeError('Supply the built-site URL and evidence directory')
await mkdir(directory, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 1280, height: 1000 },
  ignoreHTTPSErrors: true,
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const session = await context.newCDPSession(page)
await session.send('Network.enable')
await session.send('Network.setCacheDisabled', { cacheDisabled: true })
await session.send('Network.emulateNetworkConditions', {
  offline: false,
  latency: 150,
  downloadThroughput: 1_600_000 / 8,
  uploadThroughput: 750_000 / 8,
})
await session.send('Emulation.setCPUThrottlingRate', { rate: 4 })
await session.send('Page.enable')
let sequence = 0
const captures = []
session.on('Page.screencastFrame', ({ data, sessionId, metadata }) => {
  captures.push(
    writeFile(
      `${directory}/frame-${String(sequence++).padStart(4, '0')}.jpg`,
      Buffer.from(data, 'base64'),
    ),
  )
  captures.push(
    writeFile(
      `${directory}/frame-${String(sequence - 1).padStart(4, '0')}.json`,
      JSON.stringify(metadata),
    ),
  )
  void session.send('Page.screencastFrameAck', { sessionId })
})
await session.send('Page.startScreencast', { format: 'jpeg', quality: 90, everyNthFrame: 1 })
await session.send('Tracing.start', {
  categories: 'devtools.timeline,blink.user_timing,loading,disabled-by-default-devtools.screenshot',
  transferMode: 'ReturnAsStream',
})
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => performance.getEntriesByName('ghost:first-frame').length > 0, {
  timeout: 90_000,
})
await page.waitForTimeout(250)
await page.screenshot({ path: `${directory}/loaded.png`, fullPage: true })
const timeline = await page.evaluate(() => ({
  document: performance
    .getEntriesByType('navigation')
    .map(({ responseEnd, transferSize, encodedBodySize, decodedBodySize }) => ({
      responseEnd,
      transferSize,
      encodedBodySize,
      decodedBodySize,
    })),
  paint: performance.getEntriesByType('paint').map(({ name, startTime }) => ({ name, startTime })),
  milestones: performance
    .getEntriesByType('mark')
    .filter(({ name }) => name.startsWith('ghost:'))
    .map(({ name, startTime }) => ({ name, startTime })),
  resources: performance
    .getEntriesByType('resource')
    .map(({ name, startTime, responseEnd, transferSize }) => ({
      name,
      startTime,
      responseEnd,
      transferSize,
    })),
  backend: document.querySelector('#backend')?.textContent,
  prerendered: document.querySelector('#ghost-first-frame') !== null,
}))
await session.send('Page.stopScreencast')
const traceComplete = new Promise((resolve) => session.once('Tracing.tracingComplete', resolve))
await session.send('Tracing.end')
const { stream } = await traceComplete
let trace = ''
let eof = false
while (!eof) {
  const chunk = await session.send('IO.read', { handle: stream })
  trace += chunk.data
  eof = chunk.eof
}
await session.send('IO.close', { handle: stream })
await Promise.all(captures)
await writeFile(`${directory}/trace.json`, trace)
await writeFile(
  `${directory}/timeline.json`,
  JSON.stringify(
    {
      url,
      network: 'Fast 4G: 1.6 Mbps down, 750 Kbps up, 150 ms RTT',
      cpuSlowdown: 4,
      ...timeline,
      errors,
    },
    null,
    2,
  ),
)
console.log(JSON.stringify({ directory, ...timeline, errors }, null, 2))
await browser.close()

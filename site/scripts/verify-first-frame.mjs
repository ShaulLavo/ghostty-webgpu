import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const [url, directory] = process.argv.slice(2)
if (!url || !directory) throw new TypeError('Supply the built-site URL and evidence directory')
await mkdir(directory, { recursive: true })
const browser = await chromium.launch({ headless: true })
const results = []

async function geometry(page) {
  return page.evaluate(() => {
    const screen = document.querySelector('.screen').getBoundingClientRect()
    const ghost = document.querySelector('#ghost-first-frame .ghostty-webgpu-frame')
    const composition = document.querySelector('.ghostty-webgpu-composition')
    const canvas = document.querySelector('#terminal canvas')
    const cellWidth = Number.parseFloat(composition?.style.minWidth ?? '')
    const cellHeight = Number.parseFloat(composition?.style.minHeight ?? '')
    const columns =
      canvas && cellWidth ? canvas.width / Math.round(cellWidth * devicePixelRatio) : null
    const rows =
      canvas && cellHeight ? canvas.height / Math.round(cellHeight * devicePixelRatio) : null
    const context = document.createElement('canvas').getContext('2d')
    const fontMetrics = []
    if (context) {
      for (let size = 5; size <= 10; size += 1) {
        context.font = `400 ${size}px "JetBrains Mono"`
        const metrics = context.measureText('Mg')
        fontMetrics.push({
          size,
          width: context.measureText('M').width,
          ascent: metrics.fontBoundingBoxAscent,
          descent: metrics.fontBoundingBoxDescent,
        })
      }
    }
    return {
      fontMetrics,
      grid: { columns, rows },
      screen: {
        x: screen.x + scrollX,
        y: screen.y + scrollY,
        width: screen.width,
        height: screen.height,
      },
      fontSize: ghost ? getComputedStyle(ghost).fontSize : null,
      rows: ghost?.querySelectorAll('[data-row]').length,
      backend: document.querySelector('#backend').textContent,
    }
  })
}

async function handoff(width, height, deviceScaleFactor) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor,
    reducedMotion: 'reduce',
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  let release
  const waiting = new Promise((resolve) => {
    release = resolve
  })
  await page.route('**/ghostty-vt.wasm', async (route) => {
    await waiting
    await route.continue()
  })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => document.fonts.ready)
  const before = await geometry(page)
  assert.equal(before.rows, 40, 'HTML contains the complete first frame before wasm arrives')
  assert.equal(before.backend, 'html')
  assert.equal(await page.locator('#damage').getAttribute('aria-pressed'), 'false')
  assert.equal(await page.locator('#tabs button[role=tab]').count(), 3)
  assert.equal(await page.locator('#backend-fact').textContent(), 'html')
  const name = `${width}-dpr${deviceScaleFactor}`
  await writeFile(`${directory}/${name}-before.json`, JSON.stringify(before, null, 2))
  await page.waitForTimeout(150)
  await page.screenshot({ path: `${directory}/${name}-html.png`, fullPage: false })
  await page.locator('.screen').screenshot({ path: `${directory}/${name}-html-screen.png` })
  release()
  await page.waitForFunction(() => performance.getEntriesByName('ghost:first-frame').length > 0)
  const after = await geometry(page)
  await page.locator('#damage').click()
  assert.equal(await page.locator('#damage').getAttribute('aria-pressed'), 'true')
  assert.equal(await page.locator('.damage-overlay').count(), 1)
  await page.locator('#damage').click()
  assert.equal(await page.locator('.damage-overlay').count(), 0)
  assert.deepEqual(after.screen, before.screen, 'The hand-off preserves screen geometry')
  assert.equal(after.grid.rows, 40, 'The live renderer retains all ghost rows')
  assert.equal(after.grid.columns >= 78, true, 'The live renderer retains all ghost columns')
  assert.equal(
    await page.locator('#ghost-first-frame').count(),
    0,
    'The HTML frame is removed after paint',
  )
  await page.screenshot({ path: `${directory}/${name}-live.png`, fullPage: true })
  await page.locator('.screen').screenshot({ path: `${directory}/${name}-live-screen.png` })
  assert.deepEqual(errors, [])
  results.push({ name, before, after, errors })
  await context.close()
}

try {
  await handoff(1280, 1000, 1)
  await handoff(390, 844, 1)
  await handoff(1280, 1000, 2)
  await handoff(390, 844, 2)
  await handoff(390, 844, 1.3)
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    reducedMotion: 'reduce',
  })
  const page = await context.newPage()
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.getContext = () => null
    Object.defineProperty(navigator, 'gpu', { value: undefined })
  })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('#backend')?.textContent === 'dom')
  await page.waitForFunction(() => !document.querySelector('#ghost-first-frame'))
  assert.equal((await page.locator('#terminal .ghostty-webgpu-frame [data-row]').count()) > 0, true)
  await page.screenshot({ path: `${directory}/no-canvas-dom.png`, fullPage: true })
  assert.equal(await page.locator('#damage').isDisabled(), true)
  results.push({ name: 'no-canvas-dom', ...(await geometry(page)) })
  await page.locator('#tabs button[data-demo=matrix]').click()
  await page.waitForFunction(() =>
    document.querySelector('#stat').textContent.includes('cells redrawn'),
  )
  await page.locator('.screen').screenshot({ path: `${directory}/matrix-dom.png` })
  await page.locator('#tabs button[data-demo=shell]').click()
  await page.waitForFunction(() =>
    document.querySelector('#terminal').textContent.includes('bash in your browser tab'),
  )
  await page.keyboard.type('echo $((6*7))')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => /42/.test(document.querySelector('#terminal').textContent))
  await page.keyboard.type('for i in 1 2 3; do echo demo-$i; done')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() =>
    document.querySelector('#terminal').textContent.includes('demo-3'),
  )
  await page.locator('.screen').screenshot({ path: `${directory}/shell-dom.png` })
  await page.locator('#tabs button[data-demo=ghost]').click()
  await page.waitForFunction(() =>
    document.querySelector('#stat').textContent.includes('cells redrawn'),
  )
  assert.equal(await page.locator('#ghost-first-frame').count(), 0)
  results.push({
    name: 'integrated-demo-tabs',
    arithmetic: 42,
    loop: ['demo-1', 'demo-2', 'demo-3'],
  })
  await context.close()
  const noWasmContext = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
  const noWasmPage = await noWasmContext.newPage()
  await noWasmPage.addInitScript(() => {
    Object.defineProperty(globalThis, 'WebAssembly', { value: undefined })
  })
  await noWasmPage.goto(url)
  assert.equal(await noWasmPage.locator('#ghost-first-frame [data-row]').count(), 40)
  assert.equal(await noWasmPage.locator('#caption').isVisible(), true)
  assert.equal(
    await noWasmPage.locator('#caption').textContent(),
    'The live terminal did not start in this browser, so this is a still frame.',
  )
  assert.equal(await noWasmPage.locator('#tabs button:disabled').count(), 3)
  assert.equal(await noWasmPage.locator('#damage').isDisabled(), true)
  await noWasmPage.screenshot({ path: `${directory}/no-webassembly.png`, fullPage: true })
  results.push({ name: 'no-webassembly', rows: 40 })
  await noWasmContext.close()
  const staticContext = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 1280, height: 1000 },
  })
  const staticPage = await staticContext.newPage()
  await staticPage.goto(url)
  assert.equal(await staticPage.locator('#ghost-first-frame [data-row]').count(), 40)
  assert.equal(await staticPage.locator('#tabs button[role=tab]').count(), 3)
  assert.equal(await staticPage.locator('#backend').textContent(), 'html')
  assert.equal(await staticPage.locator('#damage').getAttribute('aria-pressed'), 'false')
  await staticPage.screenshot({ path: `${directory}/no-javascript.png`, fullPage: true })
  await staticContext.close()
} finally {
  await writeFile(`${directory}/verification.json`, JSON.stringify(results, null, 2))
  await browser.close()
}
console.log(JSON.stringify(results, null, 2))

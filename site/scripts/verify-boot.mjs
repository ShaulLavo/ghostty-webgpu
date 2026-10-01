import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const [url, directory] = process.argv.slice(2)
if (!url || !directory) throw new TypeError('Supply the built-site URL and evidence directory')
await mkdir(directory, { recursive: true })
const browser = await chromium.launch({ headless: true })
const results = []

async function check(name, drive, { domOnly = true, width = 1280, height = 1000 } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    reducedMotion: 'reduce',
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  if (domOnly) {
    await page.addInitScript(() => {
      HTMLCanvasElement.prototype.getContext = () => null
      Object.defineProperty(navigator, 'gpu', { value: undefined })
    })
  }
  try {
    await drive(page)
    assert.deepEqual(errors, [])
    results.push({ name, passed: true })
  } catch (cause) {
    results.push({ name, passed: false, message: String(cause), errors })
  } finally {
    await page.locator('.screen').screenshot({ path: `${directory}/${name}.png` })
    await context.close()
  }
}

async function shellWorks(page) {
  await page.waitForFunction(() =>
    document.querySelector('#terminal').textContent.includes('bash in your browser tab'),
  )
  const inputState = {
    accessibility: await page.locator('#terminal .ghostty-webgpu-accessibility').count(),
    liveRegions: await page.locator('#terminal [aria-live=polite]').count(),
    focused: await page.evaluate(() => document.activeElement?.matches('#terminal textarea')),
  }
  assert.deepEqual(
    inputState,
    { accessibility: 1, liveRegions: 1, focused: true },
    'Input demos enable accessibility and focus the terminal during startup',
  )
  await page.keyboard.type('echo boot-regression-$((6*7))')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() =>
    document.querySelector('#terminal').textContent.includes('boot-regression-42'),
  )
}

function controlPaint(button) {
  const style = getComputedStyle(button)
  return { color: style.color, background: style.backgroundColor, cursor: style.cursor }
}

async function runtimeFailure(page, asset, name) {
  let release
  const waiting = new Promise((resolve) => {
    release = resolve
  })
  await page.route(`**/${asset}`, async (route) => {
    await waiting
    await route.fulfill({ status: 404, body: 'unavailable' })
  })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => performance.getEntriesByName('ghost:create-start').length > 0)
  assert.equal(await page.locator('#ghost-first-frame [data-row]').count(), 40)
  assert.equal(await page.locator('#damage').isEnabled(), true)
  await page.screenshot({ path: `${directory}/${name}-before.png`, fullPage: true })
  await page.locator('#tabs button[data-demo=shell]').click()
  release()
  const note = 'The live terminal did not start in this browser, so this is a still frame.'
  await page.waitForFunction(
    (text) => document.querySelector('#caption').textContent === text,
    note,
    { timeout: 5000 },
  )
  assert.equal(await page.locator('#ghost-first-frame [data-row]').count(), 40)
  assert.equal(await page.locator('#tabs button:disabled').count(), 3)
  assert.equal(await page.locator('#damage').isDisabled(), true)
  assert.equal(await page.locator('#backend').textContent(), 'html')
  assert.equal(await page.locator('#backend-fact').textContent(), 'html')
  assert.equal(await page.locator('#caption').isVisible(), true)
  assert.equal(
    await page.locator('#tabs button[data-demo=ghost]').getAttribute('aria-selected'),
    'true',
  )
  assert.equal(await page.locator('#terminal').getAttribute('aria-label'), 'Ghost demo')
  for (const selector of ['#tabs button[data-demo=shell]', '#damage']) {
    const button = page.locator(selector)
    await page.mouse.move(0, 0)
    await page.waitForTimeout(200)
    const before = await button.evaluate(controlPaint)
    await button.hover()
    await page.waitForTimeout(200)
    assert.deepEqual(
      await button.evaluate(controlPaint),
      before,
      'Disabled controls have no hover styling',
    )
    assert.equal(before.cursor, 'default')
  }
  await page.keyboard.press('ArrowRight')
  assert.equal(await page.locator('#caption').textContent(), note)
  await page.screenshot({ path: `${directory}/${name}-fallback.png`, fullPage: true })
}

try {
  for (const asset of ['ghostty-vt.wasm', 'bridge.wasm']) {
    const name = `runtime-${asset}`
    await check(name, (page) => runtimeFailure(page, asset, name), {
      domOnly: false,
      width: asset === 'bridge.wasm' ? 390 : 1280,
      height: asset === 'bridge.wasm' ? 844 : 1000,
    })
  }
  const failures = [
    { name: '404', status: 404, body: 'unavailable' },
    { name: 'invalid-gzip', status: 200, body: Buffer.from([0x1f, 0x8b, 0x08, 0x00]) },
    { name: 'invalid-header', status: 200, body: 'unavailable' },
  ]
  for (const asset of failures) {
    await check(`frames-${asset.name}`, async (page) => {
      await page.route('**/ghost-frames.txt.gz', (route) =>
        route.fulfill({ status: asset.status, body: asset.body }),
      )
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(
        () => performance.getEntriesByName('ghost:open-resolved').length > 0,
        undefined,
        { timeout: 5000 },
      )
      await page.waitForFunction(() => !document.querySelector('#ghost-first-frame'))
      await page.waitForFunction(() =>
        document.querySelector('#terminal').textContent.includes('The ghost did not load.'),
      )
      await page
        .locator('.screen')
        .screenshot({ path: `${directory}/frames-${asset.name}-ghost.png` })
      await page.locator('#tabs button[data-demo=shell]').click()
      await shellWorks(page)
    })
  }
  await check('shell-selected-during-boot', async (page) => {
    let release
    const waiting = new Promise((resolve) => {
      release = resolve
    })
    await page.route('**/ghostty-vt.wasm', async (route) => {
      await waiting
      await route.continue()
    })
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => performance.getEntriesByName('ghost:create-start').length > 0)
    await page.locator('#tabs button[data-demo=shell]').click()
    assert.equal(
      await page.locator('#tabs button[data-demo=shell]').getAttribute('aria-selected'),
      'true',
    )
    assert.equal(await page.locator('#ghost-first-frame').count(), 1)
    release()
    await page.waitForFunction(() => !document.querySelector('#ghost-first-frame'))
    await shellWorks(page)
  })
} finally {
  await writeFile(`${directory}/verification.json`, JSON.stringify(results, null, 2))
  await browser.close()
}
console.log(JSON.stringify(results, null, 2))
assert.equal(
  results.every((result) => result.passed),
  true,
  'Every boot regression passes',
)

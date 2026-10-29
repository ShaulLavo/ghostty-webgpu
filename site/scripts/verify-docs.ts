import { strict as assert } from 'node:assert'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const [url, evidence] = process.argv.slice(2)
assert(url && evidence, 'Usage: bun scripts/verify-docs.ts <docs-url> <evidence-directory>')
const root = new URL(url)
const directory = resolve(evidence)
await mkdir(directory, { recursive: true })
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
const errors: string[] = []
page.on('pageerror', (error) => errors.push(error.message))
// The narrowest phones in use are 320 CSS pixels wide; no page may scroll sideways on them.
const WIDTHS = [1440, 390, 320]
const paths = [
  '',
  'guides/pty/',
  'guides/scrollback/',
  'start/quick-start/',
  'start/xterm/',
  'reference/options/',
  'reference/api/',
  'examples/echo/',
]
try {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 960 })
    for (const path of paths) {
      const response = await page.goto(new URL(path, root).href)
      assert.equal(response?.status(), 200)
      await page.locator('h1').waitFor()
      if (path === 'start/quick-start/' || path === 'examples/echo/') {
        await page.locator('[data-docs-terminal]').scrollIntoViewIfNeeded()
        await page.getByRole('textbox', { name: 'Terminal input' }).waitFor()
        assert(
          await page
            .locator('[data-docs-terminal]')
            .evaluate((host) => getComputedStyle(host).backgroundColor !== 'rgba(0, 0, 0, 0)'),
          'Echo terminal needs an opaque background for readable text',
        )
        const screen = page
          .locator('[data-docs-terminal]')
          .getByRole('list', { name: 'Terminal screen' })
        await screen
          .getByRole('listitem')
          .filter({ hasText: 'Hello from Ghostty.' })
          .waitFor({ state: 'attached' })
        await page
          .getByRole('textbox', { name: 'Terminal input' })
          .pressSequentially('docs-echo-check')
        await screen
          .getByRole('listitem')
          .filter({ hasText: 'docs-echo-check' })
          .waitFor({ state: 'attached' })
      }
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${path} overflows at ${width}`,
      )
      await page.screenshot({
        path: `${directory}/${width}-${path.replaceAll('/', '-') || 'home'}.png`,
        fullPage: true,
      })
    }
  }
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 960 })
    for (const [name, path] of [
      ['landing', '../'],
      ['not-found', '../404.html'],
    ] as const) {
      await page.goto(new URL(path, root).href)
      await page.locator('main').waitFor()
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${name} overflows at ${width}`,
      )
    }
  }
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto(new URL('../', root).href)
  assert.equal(
    await page.getByRole('link', { name: '[ docs ]', exact: true }).getAttribute('href'),
    root.pathname,
  )
  assert(
    await page.evaluate(async () => {
      const faces = await document.fonts.load('15px "Paper Mono"')
      return faces.length > 0 && faces.every((face) => face.status === 'loaded')
    }),
    'Paper Mono must load under the active hosting base',
  )
  await page.screenshot({ path: `${directory}/landing.png`, fullPage: true })
  // The scene is decoration: the first Tab reaches the project links.
  await page.locator('#scene canvas').first().waitFor()
  await page.keyboard.press('Tab')
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent?.trim()),
    '[ docs ]',
    'The first Tab on the landing page lands on the project links',
  )
  // A resized window refits the scene as a fresh load at that width does.
  const sceneHeight = () => page.evaluate(() => document.getElementById('scene')!.clientHeight)
  const wide = await sceneHeight()
  await page.setViewportSize({ width: 320, height: 960 })
  await page.waitForFunction(
    (before) => document.getElementById('scene')!.clientHeight < before / 2,
    wide,
  )
  await page.waitForTimeout(300)
  const resized = await sceneHeight()
  await page.reload()
  await page.locator('#scene canvas').first().waitFor()
  await page.waitForFunction(() => document.querySelector('#scene .scene-first') === null)
  assert(
    Math.abs((await sceneHeight()) - resized) <= 2,
    `Resized scene is ${resized}px tall, a fresh load differs`,
  )
  await page.setViewportSize({ width: 1440, height: 960 })
  // The first frame and the terminal that replaces it draw the same grid, at fractional pixel ratios too.
  for (const [width, deviceScaleFactor] of [
    [2560, 1],
    [1850, 2],
    [1024, 1.5],
    [1023, 1.5],
    [321, 1.5],
    [420, 1.25],
    [390, 3],
  ] as const) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      deviceScaleFactor,
    })
    const scenePage = await context.newPage()
    await scenePage.goto(new URL('../?scene=tokyo-rain', root).href)
    await scenePage.waitForFunction(() => document.getElementById('scene')!.dataset['terminalGrid'])
    const grids = await scenePage.evaluate(() => {
      const scene = document.getElementById('scene')!
      return [scene.dataset['grid'], scene.dataset['terminalGrid']]
    })
    assert.equal(
      grids[1],
      grids[0],
      `First frame and terminal grids differ at ${width}px, ratio ${deviceScaleFactor}`,
    )
    await context.close()
  }
  // The art's boxes are sized before any script runs: the sections below sit where they will stay.
  for (const width of [1440, 390]) {
    const positions: number[] = []
    for (const scripts of [false, true]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } })
      const artPage = await context.newPage()
      if (!scripts) await artPage.route(/\/_astro\/.*\.js$|\.wasm$/, (route) => route.abort())
      await artPage.goto(new URL('../?scene=tokyo-rain', root).href)
      if (scripts) await artPage.locator('[data-art="wordmark"] canvas').waitFor()
      positions.push(
        await artPage.evaluate(
          () => document.getElementById('measured')!.getBoundingClientRect().top,
        ),
      )
      await context.close()
    }
    assert(
      Math.abs(positions[0]! - positions[1]!) <= 1,
      `Art moved the page at ${width}px: ${positions.join(' → ')}`,
    )
  }
  // A mouse selects and copies scene cells without taking the keyboard; touch on the same device passes through.
  {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      hasTouch: true,
      permissions: ['clipboard-read', 'clipboard-write'],
    })
    const scenePage = await context.newPage()
    await scenePage.goto(new URL('../?scene=tokyo-rain', root).href)
    await scenePage.waitForFunction(() => !document.querySelector('.scene-first'))
    const sceneBox = (await scenePage.locator('#scene').boundingBox())!
    await scenePage.mouse.move(sceneBox.x + 100, sceneBox.y + 100)
    await scenePage.mouse.down()
    await scenePage.mouse.move(sceneBox.x + 400, sceneBox.y + 180, { steps: 10 })
    await scenePage.mouse.up()
    await scenePage.keyboard.press('Control+c')
    assert(
      (await scenePage.evaluate(() => navigator.clipboard.readText())).length > 0,
      'Ctrl+C copies the selected scene cells',
    )
    const inScene = () =>
      scenePage.evaluate(() => Boolean(document.activeElement?.closest('#scene')))
    assert(!(await inScene()), 'A mouse selection leaves focus outside the scene')
    await scenePage.keyboard.press('Tab')
    assert.equal(
      await scenePage.evaluate(() => document.activeElement?.textContent?.trim()),
      '[ docs ]',
    )
    // The hero's tagline is text a mouse can select.
    const lede = (await scenePage.locator('.lede').boundingBox())!
    await scenePage.mouse.move(lede.x + 2, lede.y + lede.height / 2)
    await scenePage.mouse.down()
    await scenePage.mouse.move(lede.x + lede.width - 2, lede.y + lede.height / 2, { steps: 8 })
    await scenePage.mouse.up()
    assert.match(
      await scenePage.evaluate(() => String(getSelection())),
      /WebAssembly/,
      'The tagline can be selected',
    )
    await scenePage.touchscreen.tap(sceneBox.x + 200, sceneBox.y + 120)
    assert(!(await inScene()), 'A touch on the scene leaves focus outside it')
    await context.close()
  }
  // A missing page at any depth is the site's 404, with its font.
  const missing = await page.goto(new URL('../missing/deep/', root).href)
  assert.equal(missing?.status(), 404)
  await page.locator('#not-found').waitFor()
  assert(
    await page.evaluate(async () => {
      const faces = await document.fonts.load('15px "Paper Mono"')
      return faces.length > 0 && faces.every((face) => face.status === 'loaded')
    }),
    'Paper Mono must load on a nested missing page',
  )
  await page.goto(root.href)
  await page.getByRole('button', { name: 'Search' }).click()
  await page.getByRole('dialog', { name: 'Search' }).getByRole('textbox').fill('scrollback')
  await page.locator('.pagefind-ui__result-link').first().waitFor()
  await page.screenshot({ path: `${directory}/search.png` })
  assert.equal(errors.length, 0, errors.join('\n'))
  await writeFile(
    `${directory}/verification.json`,
    JSON.stringify(
      {
        url: root.href,
        widths: WIDTHS,
        pages: paths,
        errors,
        search: 'scrollback',
      },
      null,
      2,
    ),
  )
  console.log(`Docs browser checks passed. Evidence: ${directory}`)
} finally {
  await browser.close()
}

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
  for (const width of [1440, 390]) {
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
        await page
          .getByRole('textbox', { name: 'Terminal input' })
          .pressSequentially('docs-echo-check')
        await page.waitForFunction(() =>
          document.querySelector('[data-docs-terminal]')?.textContent?.includes('docs-echo-check'),
        )
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
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto(new URL('../', root).href)
  assert.equal(
    await page.getByRole('link', { name: 'Docs', exact: true }).getAttribute('href'),
    root.pathname,
  )
  assert(
    await page.evaluate(async () => {
      const faces = await document.fonts.load('19px "Bricolage Grotesque"')
      return faces.length > 0 && faces.every((face) => face.status === 'loaded')
    }),
    'Landing font must load under the active hosting base',
  )
  await page.screenshot({ path: `${directory}/landing.png`, fullPage: true })
  await page.goto(root.href)
  await page.getByRole('button', { name: 'Search' }).click()
  await page.getByRole('dialog', { name: 'Search' }).getByRole('textbox').fill('scrollback')
  await page.locator('.pagefind-ui__result-link').first().waitFor()
  await page.screenshot({ path: `${directory}/search.png` })
  assert.equal(errors.length, 0, errors.join('\n'))
  await writeFile(
    `${directory}/verification.json`,
    JSON.stringify(
      { url: root.href, widths: [1440, 390], pages: paths, errors, search: 'scrollback' },
      null,
      2,
    ),
  )
  console.log(`Docs browser checks passed. Evidence: ${directory}`)
} finally {
  await browser.close()
}

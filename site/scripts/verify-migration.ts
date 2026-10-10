// Checks build-time highlighting and unbroken migration expressions with JavaScript disabled.
// Usage: bun scripts/verify-migration.ts [evidence-directory] [landing-url] (after `bun run build`)
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, webkit, type Page } from 'playwright'
import { migrationComparison, migrationRendererOption } from '../src/examples/migration-comparison'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const evidence = process.argv[2]
const landingUrl = process.argv[3] ?? 'http://migration.test/ghostty-webgpu/'
const guideUrl = new URL('docs/start/xterm/', landingUrl).href
if (evidence) await mkdir(evidence, { recursive: true })
const widths = Array.from(
  new Set(
    Array.from({ length: 23 }, (_, index) => 320 + index * 50).concat([390, 600, 601, 768, 1440]),
  ),
)
widths.sort((first, second) => first - second)
const screenshotWidths = new Set([320, 390, 768, 1440])

function luminance(color: string): number {
  const channels = color
    .match(/[\d.]+/g)!
    .slice(0, 3)
    .map((value) => {
      const channel = Number(value) / 255
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
}

async function verifyGuide(page: Page, engine: string, width: number, expected: readonly string[]) {
  await page.goto(guideUrl)
  await page.evaluate(() => document.fonts.ready)
  const table = page.getByRole('table', { name: 'xterm.js to ghostty-webgpu' })
  assert.deepEqual(await table.locator('pre code').allTextContents(), expected)
  assert.equal(await table.locator('td pre').count(), migrationComparison.length * 2)
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme
    }, theme)
    const layout = await table.evaluate((element) => ({
      documentWidth: document.documentElement.scrollWidth,
      tableWidth: element.getBoundingClientRect().width,
      tableScrollWidth: element.scrollWidth,
      background: getComputedStyle(element.querySelector('pre')!).backgroundColor,
      colors: Array.from(
        new Set(
          Array.from(
            element.querySelectorAll('pre code span[style]'),
            (span) => getComputedStyle(span).color,
          ),
        ),
      ),
    }))
    assert.ok(layout.documentWidth <= width, `${engine} ${width} ${theme}: guide page fits`)
    assert.ok(
      layout.tableScrollWidth <= Math.ceil(layout.tableWidth),
      `${engine} ${width} ${theme}: guide comparison fits`,
    )
    const background = luminance(layout.background)
    for (const color of layout.colors) {
      const foreground = luminance(color)
      const contrast =
        (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05)
      assert.ok(
        contrast >= 4.5,
        `${engine} ${width} ${theme}: ${color} contrast ${contrast} is readable`,
      )
    }
    if (evidence)
      await Bun.write(
        join(evidence, `${engine}-${width}-guide-${theme}.json`),
        JSON.stringify(layout, null, 2),
      )
    if (evidence && screenshotWidths.has(width))
      await table.screenshot({ path: join(evidence, `${engine}-${width}-guide-${theme}.png`) })
  }
}

for (const [engine, launcher] of Object.entries({ chromium, webkit })) {
  const browser = await launcher.launch()
  try {
    for (const width of widths) {
      const page = await browser.newPage({
        javaScriptEnabled: false,
        viewport: { width, height: 1000 },
      })
      if (!process.argv[3])
        await page.route('http://migration.test/**', async (route) => {
          const path = new URL(route.request().url()).pathname.replace(/^\/ghostty-webgpu\//, '')
          const file = join(dist, path.endsWith('/') || !path ? `${path}index.html` : path)
          await route.fulfill({ path: file })
        })
      await page.goto(landingUrl)
      await page.evaluate(() => document.fonts.ready)
      const table = page.getByRole('table', { name: 'xterm.js to ghostty-webgpu' })
      const expected = migrationComparison.flatMap(({ from, to }) => Array.of<string>(from, to))
      assert.equal(await table.locator('tbody tr').count(), migrationComparison.length)
      assert.deepEqual(await table.locator('pre code').allTextContents(), expected)
      assert.equal(
        await table
          .locator('td')
          .filter({ hasText: /built in|terminal\.onData|loadAddon|rendererMode|rendererFactory/ })
          .count(),
        0,
      )
      assert.equal(await table.locator('td pre').count(), migrationComparison.length * 2)
      assert.equal(
        await page.locator('.callout p code').filter({ hasText: migrationRendererOption }).count(),
        1,
      )
      const layout = await table.evaluate((element) => ({
        viewport: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        tableWidth: element.getBoundingClientRect().width,
        tableScrollWidth: element.scrollWidth,
        expressions: Array.from(element.querySelectorAll('pre code'), (code) => {
          const range = document.createRange()
          range.selectNodeContents(code)
          const bounds = range.getBoundingClientRect()
          const pre = code.parentElement!
          const colors = Array.from(
            code.querySelectorAll('span[style]'),
            (span) => getComputedStyle(span).color,
          )
          return {
            text: code.textContent,
            height: bounds.height,
            lineHeight: Number.parseFloat(getComputedStyle(pre).lineHeight),
            width: bounds.width,
            availableWidth: pre.clientWidth,
            colors: Array.from(new Set(colors)),
          }
        }),
      }))
      assert.ok(layout.documentWidth <= width, `${engine} ${width}: page fits viewport`)
      assert.ok(
        layout.tableScrollWidth <= Math.ceil(layout.tableWidth),
        `${engine} ${width}: table fits`,
      )
      for (const expression of layout.expressions) {
        assert.ok(
          expression.height <= expression.lineHeight + 1,
          `${expression.text} stays on one line`,
        )
        assert.ok(
          expression.width <= expression.availableWidth + 1,
          `${expression.text} fits its cell`,
        )
        if (expression.text === '@xterm/headless') continue
        assert.ok(expression.colors.length >= 2, `${expression.text} has syntax colours`)
      }
      if (evidence) {
        await Bun.write(join(evidence, `${engine}-${width}.json`), JSON.stringify(layout, null, 2))
        if (screenshotWidths.has(width))
          await page
            .locator('.callout')
            .screenshot({ path: join(evidence, `${engine}-${width}.png`) })
      }
      await verifyGuide(page, engine, width, expected)
      console.log(
        `${engine} ${width}: light/dark guide contrast, container fit and unbroken static snippets pass`,
      )
      await page.close()
    }
  } finally {
    await browser.close()
  }
}

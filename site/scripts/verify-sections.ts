// Checks focus outlines on the benchmark controls and roadmap status contrast in both color schemes.
// Usage: bun scripts/verify-sections.ts [evidence-directory]  (after `bun run build`)
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const evidence = process.argv[2]
if (evidence) await mkdir(evidence, { recursive: true })

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const path = new URL(request.url).pathname.replace(/^\/ghostty-webgpu\//, '/')
    const file = Bun.file(join(dist, path.endsWith('/') ? `${path}index.html` : path))
    return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 })
  },
})

// Resolves any CSS color (including color-mix) to sRGB through a canvas, then applies WCAG contrast.
function contrastInPage(page: Page, selector: string, property: 'color' | 'outlineColor') {
  return page.evaluate(
    ([target, key]) => {
      const canvas = document
        .createElement('canvas')
        .getContext('2d', { willReadFrequently: true })!
      const rgba = (color: string) => {
        canvas.clearRect(0, 0, 1, 1)
        canvas.fillStyle = color
        canvas.fillRect(0, 0, 1, 1)
        return [...canvas.getImageData(0, 0, 1, 1).data]
      }
      const background = (element: Element | null): number[] => {
        for (let node = element; node; node = node.parentElement) {
          const value = rgba(getComputedStyle(node).backgroundColor)
          if (value[3] === 255) return value
        }
        return rgba(getComputedStyle(document.body).backgroundColor)
      }
      const luminance = ([r, g, b]: number[]) =>
        [r!, g!, b!]
          .map((channel) => channel / 255)
          .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
          .reduce((sum, c, index) => sum + c * [0.2126, 0.7152, 0.0722][index]!, 0)
      const element = document.querySelector(target)!
      const parent = key === 'outlineColor' ? element.parentElement : element
      const [high, low] = [
        luminance(rgba(getComputedStyle(element)[key])),
        luminance(background(parent)),
      ].sort((a, b) => b - a)
      return (high! + 0.05) / (low! + 0.05)
    },
    [selector, property] as const,
  )
}

const browser = await chromium.launch()
const failures: string[] = []
try {
  for (const colorScheme of ['light', 'dark'] as const) {
    const page = await browser.newPage({
      colorScheme,
      reducedMotion: 'reduce',
      viewport: { width: 1440, height: 900 },
    })
    await page.goto(`http://127.0.0.1:${server.port}/ghostty-webgpu/`)
    const checks: [string, string, 'color' | 'outlineColor', number][] = [
      ['#bench-tab-webgl', 'benchmark tab focus', 'outlineColor', 3],
      ['#bench-panel-webgl [data-toggle-view]', 'table toggle focus', 'outlineColor', 3],
      ['.roadmap .st-progress', 'In progress label', 'color', 4.5],
      ['.roadmap .st-done', 'Done label', 'color', 4.5],
    ]
    for (const [selector, name, property, minimum] of checks) {
      if (property === 'outlineColor') {
        await page.keyboard.press('Shift')
        await page.locator(selector).focus()
        assert.ok(
          await page.locator(selector).evaluate((element) => element.matches(':focus-visible')),
        )
      }
      const ratio = await contrastInPage(page, selector, property)
      const line = `${colorScheme} ${name}: ${ratio.toFixed(2)}:1 (minimum ${minimum}:1)`
      console.log(line)
      if (ratio < minimum) failures.push(line)
    }
    if (evidence) {
      await page.locator('#bench-panel-webgl [data-toggle-view]').focus()
      await page
        .locator('#bench-card')
        .screenshot({ path: join(evidence, `focus-${colorScheme}.png`) })
    }
    await page.close()
  }
} finally {
  await browser.close()
  server.stop()
}
assert.deepEqual(failures, [], 'Every focus outline and roadmap label meets its contrast minimum')

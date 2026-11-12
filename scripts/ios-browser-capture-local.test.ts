import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { chromium, webkit, type Page, type Frame } from 'playwright'
import { transformWithOxc } from 'vite'
import { PNG } from 'pngjs'
import { test } from 'vitest'
import {
  measureCapture,
  planEnclosingCrop,
  prepareCapture,
} from './ios-browser-capture-geometry.ts'
import { cropPngLossless, inspectCapturePng } from './ios-browser-capture-png.ts'
import { captureCanvas, captureLandmarks } from './ios-browser-capture-fixture.ts'

const root = new URL('../', import.meta.url)
type Mode = 'positive' | 'wrong-size' | 'wrong-color' | 'wrong-origin' | 'wrong-crop'

async function capture(page: Page, frame: Frame, mode: Mode): Promise<Buffer> {
  const element = frame.locator('canvas')
  await element.evaluate(prepareCapture)
  const before = await element.evaluate(measureCapture)
  assert(before)
  if (mode === 'wrong-color')
    await element.evaluate((canvas: HTMLCanvasElement) => {
      const context = canvas.getContext('2d')!
      context.fillStyle = 'green'
      context.fillRect(0, 0, 48, 48)
    })
  const source = await page.screenshot({ scale: 'device' })
  const after = await element.evaluate(measureCapture)
  assert.deepEqual(after, before)
  let crop
  try {
    crop = planEnclosingCrop(before, inspectCapturePng(source))
  } catch (error) {
    throw new Error(`${String(error)}: ${JSON.stringify(before)}`)
  }
  if (mode === 'wrong-size') {
    crop.width -= 3
    crop.height -= 3
  }
  if (mode === 'wrong-origin') crop.x++
  if (mode === 'wrong-crop') {
    const decoded = PNG.sync.read(source)
    const row = crop.y + 19
    decoded.data.copy(
      decoded.data,
      (row * decoded.width + crop.x) * 4,
      ((row + 1) * decoded.width + crop.x) * 4,
      ((row + 1) * decoded.width + crop.x + crop.width) * 4,
    )
    return cropPngLossless(PNG.sync.write(decoded), crop)
  }
  const output = cropPngLossless(source, crop)
  if (mode === 'positive') await compareBrowserDecode(frame, source, output, crop)
  return output
}

async function compareBrowserDecode(
  frame: Frame,
  source: Buffer,
  output: Buffer,
  crop: { x: number; y: number; width: number; height: number },
): Promise<void> {
  const equal = await frame.evaluate(
    async ({ source, output, crop }) => {
      async function decode(base64: string): Promise<HTMLImageElement> {
        const image = new Image()
        image.src = `data:image/png;base64,${base64}`
        await image.decode()
        return image
      }
      const viewport = await decode(source)
      const cropped = await decode(output)
      const canvas = document.createElement('canvas')
      canvas.width = crop.width
      canvas.height = crop.height
      const context = canvas.getContext('2d')!
      context.drawImage(
        viewport,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        crop.width,
        crop.height,
      )
      const expected = context.getImageData(0, 0, crop.width, crop.height).data
      context.clearRect(0, 0, crop.width, crop.height)
      context.drawImage(cropped, 0, 0)
      const actual = context.getImageData(0, 0, crop.width, crop.height).data
      return actual.every((value, index) => value === expected[index])
    },
    { source: source.toString('base64'), output: output.toString('base64'), crop },
  )
  assert.equal(equal, true, 'Browser color decoding changed cropped viewport samples')
}

async function transpile(source: string): Promise<string> {
  return (await transformWithOxc(source, 'capture-control.ts')).code
    .replace(/^import.*\n/gm, '')
    .replace(/^export /gm, '')
}

async function originalHarness(): Promise<string> {
  const original = await readFile(
    new URL('src/render/webgl/tests/fixture.browser.test.ts', root),
    'utf8',
  )
  assert.equal(
    createHash('sha256').update(original).digest('hex'),
    'bf1a8296342bb21c73db9bb6b360ac212e91592cb9f1667425e6fbc28c924a68',
  )
  const helper = await readFile(new URL('src/render/webgl/tests/fixture.ts', root), 'utf8')
  assert.equal(
    createHash('sha256').update(helper).digest('hex'),
    'f8cda88300bb29bcb53b0f567ede9b2b013b96ba31cfb0a3ed368ace5ab68b03',
  )
  return `let selected; const it = (_name, callback) => { selected = callback; };
const page = { screenshot: async () => window.__capture() };
const expect = (actual) => ({ toEqual(expected) { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('content or dimensions: ' + JSON.stringify(actual)); }, toBe(expected) { if (actual !== expected) throw new Error('scalar'); } });
${await transpile(helper)}\n${await transpile(original)}\nawait selected();`
}

test.each(['chromium', 'webkit'] as const)(
  'real %s viewport crop with offset frame and both scroll positions',
  async (engine) => {
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      browser = await (engine === 'chromium' ? chromium : webkit).launch({ headless: true })
      const page = await browser.newPage({
        viewport: { width: 414, height: 896 },
        deviceScaleFactor: 3,
      })
      await page.setContent(
        '<style>body{margin:0;height:2000px}iframe{position:absolute;left:20px;top:180px;width:300px;height:600px;border:2px solid black;padding:2px}</style><iframe srcdoc="<!doctype html><style>body{margin:0;min-height:2000px}</style>"></iframe>',
      )
      const frame = page.frames().find((candidate) => candidate !== page.mainFrame())
      assert(frame)
      await page.evaluate(() => window.scrollTo(0, 100))
      let mode: Mode = 'positive'
      await page.exposeFunction('__capture', async () =>
        (await capture(page, frame, mode)).toString('base64'),
      )
      const harness = await originalHarness()
      for (const selected of ['positive', 'wrong-size', 'wrong-color'] as const) {
        mode = selected
        await checkOriginal(frame, harness, selected)
      }
      mode = 'positive'
      await checkScrolledCaptures(page, frame)
      await frame.evaluate(clearCanvases)
      await frame.evaluate(captureCanvas, { left: 10, top: 10 })
      await frame.evaluate(() => window.scrollTo(0, 0))
      const good = await capture(page, frame, 'positive')
      assertLandmarks(good)
      await assert.rejects(async () => assertLandmarks(await capture(page, frame, 'wrong-origin')))
      await assert.rejects(async () => assertLandmarks(await capture(page, frame, 'wrong-crop')))
      await frame.evaluate(() => {
        const container = document.createElement('div')
        container.id = 'scroll-container'
        container.style.cssText =
          'position:absolute;left:0;top:0;width:240px;height:120px;overflow:auto'
        const canvas = document.querySelector<HTMLCanvasElement>('canvas')!
        canvas.style.top = '450px'
        container.append(canvas)
        document.body.append(container)
      })
      await capture(page, frame, 'positive')
      assert((await frame.locator('#scroll-container').evaluate((node) => node.scrollTop)) > 0)
      await page.evaluate(() => {
        const overlay = document.createElement('div')
        overlay.id = 'corner-obstruction'
        overlay.style.cssText = 'position:fixed;inset:0;background:black;z-index:100000'
        document.body.append(overlay)
      })
      assert.equal(
        (await frame.locator('canvas').evaluate(measureCapture))?.frame.cornersHitFrame,
        false,
      )
      await page.locator('#corner-obstruction').evaluate((node) => node.remove())
      await page.locator('iframe').evaluate((node) => {
        node.style.transform = 'rotate(180deg)'
      })
      assert.equal(await frame.locator('canvas').evaluate(measureCapture), null)
      await page.locator('iframe').evaluate((node) => {
        node.style.transform = 'none'
      })
      await page.locator('iframe').evaluate((node) => {
        node.style.left = '20.5px'
      })
      await assert.rejects(() => capture(page, frame, 'positive'), /integer device pixel/)
      await page.locator('iframe').evaluate((node) => {
        node.style.left = '20px'
      })
      await frame.locator('canvas').evaluate((canvas) => {
        canvas.style.transform = 'rotate(180deg)'
      })
      assert.equal(await frame.locator('canvas').evaluate(measureCapture), null)
    } finally {
      await browser?.close()
    }
  },
  30000,
)

async function checkOriginal(frame: Frame, harness: string, mode: Mode): Promise<void> {
  const run = () =>
    frame.evaluate(
      async (source) => new Function(`return (async () => { ${source} })()`)(),
      harness,
    )
  if (mode === 'positive') {
    await run()
    return
  }
  await assert.rejects(run, mode === 'wrong-size' ? /\[126,78\]/ : /\[0,128,0,255\]/)
}

async function checkScrolledCaptures(page: Page, frame: Frame): Promise<void> {
  for (const top of [10, 10.5, 110, 1400]) {
    await frame.evaluate(clearCanvases)
    await frame.evaluate(captureCanvas, { left: 10.5, top })
    await frame.evaluate(() => window.scrollTo(0, 100))
    const output = await capture(page, frame, 'positive')
    assert.equal(inspectCapturePng(output).width, 129)
    if (top === 110) assert.equal(await frame.evaluate(() => scrollY), 100)
  }
}

function clearCanvases(): void {
  for (const canvas of document.querySelectorAll('canvas')) canvas.remove()
}

function assertLandmarks(buffer: Buffer): void {
  const image = PNG.sync.read(buffer)
  assert.deepEqual([image.width, image.height], [126, 78])
  for (const { x, y, rgba } of captureLandmarks) {
    const index = ((y + 15) * image.width + x + 15) * 4
    assert.deepEqual(Array.from(image.data.subarray(index, index + 4)), rgba)
  }
  const edges = [
    { x: 1, y: 30, rgba: [255, 0, 0, 255] },
    { x: 30, y: 1, rgba: [0, 255, 0, 255] },
    { x: 124, y: 30, rgba: [0, 0, 255, 255] },
    { x: 30, y: 76, rgba: [255, 0, 255, 255] },
  ]
  for (const { x, y, rgba } of edges)
    assert.deepEqual(
      Array.from(image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)),
      rgba,
    )
}

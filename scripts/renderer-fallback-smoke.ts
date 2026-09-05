import assert from 'node:assert/strict'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
import { displayedInk } from './displayed-ink'

const root = process.env.GHOSTTY_PACKAGE_ROOT ?? join(import.meta.dirname, '..')
const consumerRoot = process.env.GHOSTTY_PACKAGE_ROOT ? join(root, '../..') : root
const origin = 'http://127.0.0.1:41799'
const backends = ['webgpu', 'webgl2', 'canvas2d'] as const
const requested = process.argv.slice(2)
for (const backend of requested) {
  assert(
    backends.some((candidate) => candidate === backend),
    `Unknown renderer backend: ${backend}`,
  )
}
const selected = backends.filter((backend) => requested.length === 0 || requested.includes(backend))
const imports = {
  '@tanstack/hotkeys': '/node_modules/@tanstack/hotkeys/dist/index.js',
  '@tanstack/store': '/node_modules/@tanstack/store/dist/index.js',
}
const args = ['--enable-unsafe-webgpu']
if (process.platform === 'linux') {
  args.push('--enable-features=Vulkan', '--use-webgpu-adapter=swiftshader')
}

const openScenario = `(async () => {
  const { Terminal } = await import('/dist/index.js');
  const terminal = await Terminal.create({ appearance: { cursor: { blink: false } } });
  globalThis.rendererSmokeTerminal = terminal;
  await terminal.open(document.querySelector('main'));
  terminal.setTheme({ ...terminal.appearance.theme, foreground: { r: 255, g: 0, b: 0 } });
  terminal.write('\\x1b[?25lbuilt-fallback-ok');
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return { backend: terminal.diagnostics.rendererBackend, text: terminal.visibleLines().join('\\n') };
})()`

const themeScenario = `(async () => {
  const terminal = globalThis.rendererSmokeTerminal;
  terminal.setTheme({ ...terminal.appearance.theme, foreground: { r: 0, g: 255, b: 0 } });
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
})()`

async function checkPresentation(page: Page, backend: string): Promise<void> {
  const initial = await displayedInk(page)
  assert(initial.red > 20, `${backend}: expected visible red glyph pixels, got ${initial.red}`)
  assert.equal(initial.green, 0)
  await page.evaluate(themeScenario)
  const updated = await displayedInk(page)
  assert(
    updated.green > 20,
    `${backend}: expected visible green glyph pixels, got ${updated.green}`,
  )
  assert.equal(updated.red, 0, `${backend}: old red glyphs remain after changing the theme`)
}

const browser = await chromium.launch({ args, channel: 'chromium', headless: true })
try {
  for (const backend of selected) await checkBackend(backend)
} finally {
  await browser.close()
}

async function checkBackend(backend: (typeof backends)[number]): Promise<void> {
  console.log(`Checking built package with ${backend}`)
  const page = await browser.newPage()
  page.setDefaultTimeout(15_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/') {
      await route.fulfill({
        body: `<!doctype html><script type="importmap">${JSON.stringify({ imports })}</script><main style="width:640px;height:320px"></main>`,
        contentType: 'text/html',
      })
      return
    }
    const allowed =
      path.startsWith('/dist/') ||
      path.startsWith('/node_modules/@tanstack/') ||
      path === '/ghostty-vt.wasm' ||
      path === '/bridge.wasm'
    if (!allowed) return route.abort()
    const fileRoot = path.startsWith('/node_modules/') ? consumerRoot : root
    const file = Bun.file(join(fileRoot, path))
    await route.fulfill({
      body: Buffer.from(await file.arrayBuffer()),
      contentType: path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
    })
  })
  await page.addInitScript((selected) => {
    if (selected === 'webgpu') return
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined })
    if (selected === 'webgl2') return
    const original = HTMLCanvasElement.prototype.getContext
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value(this: HTMLCanvasElement, kind: string, options?: object): unknown {
        if (kind === 'webgl2') return null
        return Reflect.apply(original, this, [kind, options])
      },
    })
  }, backend)
  try {
    await page.goto(origin)
    const result: unknown = await page.evaluate(
      `Promise.race([${openScenario}, new Promise((_, reject) => setTimeout(() => reject(new Error('Terminal smoke timed out')), 15000))])`,
    )
    assert(result && typeof result === 'object')
    assert('backend' in result && 'text' in result)
    assert.equal(result.backend, backend)
    assert.equal(typeof result.text, 'string')
    assert(String(result.text).includes('built-fallback-ok'))
    await checkPresentation(page, backend)
    const selection: unknown = await page.evaluate(`(() => {
      const terminal = globalThis.rendererSmokeTerminal;
      terminal.selectAll();
      return terminal.getSelection();
    })()`)
    assert.equal(typeof selection, 'string')
    assert(String(selection).includes('built-fallback-ok'))
    await page.evaluate('globalThis.rendererSmokeTerminal.dispose()')
    assert.equal(await page.locator('main canvas').count(), 0)
    assert.deepEqual(errors, [])
    console.log(
      `${backend}: displayed glyphs change from red to green, selection and disposal pass`,
    )
  } finally {
    await page.close()
  }
}

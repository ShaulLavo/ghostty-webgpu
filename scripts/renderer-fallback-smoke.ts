import assert from 'node:assert/strict'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
import { displayedInk } from './displayed-ink'
import { swiftShaderArgs, swiftShaderEnv } from './swiftshader-launch.mjs'
import { rendererSmokeHotkeys } from './renderer-smoke-dependency'

const root = process.env.GHOSTTY_PACKAGE_ROOT ?? join(import.meta.dirname, '..')
const hotkeys = await rendererSmokeHotkeys(root)
const origin = 'http://127.0.0.1:41799'
const backends = ['webgpu', 'webgl2', 'canvas2d', 'canvas2d-pixels'] as const
const requested = process.argv.slice(2)
for (const backend of requested) {
  assert(
    backends.some((candidate) => candidate === backend),
    `Unknown renderer backend: ${backend}`,
  )
}
const selected = backends.filter((backend) => requested.length === 0 || requested.includes(backend))
const imports = {
  '@fregat/hotkeys': '/smoke-hotkeys.js',
}
const hardware = process.env.GHOSTTY_BROWSER_HARDWARE === '1'
const args = ['--enable-unsafe-webgpu']
const swiftShader = process.platform === 'linux' && !hardware
if (swiftShader) args.push(...swiftShaderArgs)
if (hardware && process.platform === 'linux' && process.env.WAYLAND_DISPLAY)
  args.push('--ozone-platform=wayland')

const openScenario = `(async (backend, bidi, worker) => {
  const api = await import(worker ? '/dist/worker/index.js' : '/dist/index.js');
  const { Terminal } = api;
  const rendererFactory = backend === 'webgpu' && !worker
    ? (options) => api.WebGpuTerminalRenderer.create(options)
    : undefined;
  const rendererMode = backend === 'canvas2d-pixels' ? backend : undefined;
  const terminal = await Terminal.create({ appearance: { cursor: { blink: false } }, rendererFactory, rendererMode, bidi, ...(worker ? { backend: backend === 'webgl2' ? 'webgl' : 'webgpu', fonts: [{family:'SmokeFont',source:{url:new URL('/smoke-font.ttf',location.href).href}}] } : {}) });
  globalThis.rendererSmokeTerminal = terminal;
  await terminal.open(document.querySelector('main'));
  await terminal.setTheme({ ...terminal.appearance.theme, foreground: { r: 255, g: 0, b: 0 } });
  await terminal.write('\\x1b[?25lbuilt-fallback-ok' + (bidi ? ' ab שלום cd' : ''));
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await waitForSubmitted(terminal);
  return { backend: terminal.diagnostics.rendererBackend, text: terminal.visibleLines().join('\\n') };
  async function waitForSubmitted(terminal) {
    const revision = (await terminal.geometry()).revision;
    for (let attempt=0;attempt<500;attempt++) {
      if ((terminal.submittedFrame?.nativeRevision ?? -1) >= revision) return;
      await new Promise(resolve => setTimeout(resolve,10));
    }
    throw new Error('No submitted frame for parsed state');
  }
})`

const themeScenario = `(async () => {
  const terminal = globalThis.rendererSmokeTerminal;
  await terminal.setTheme({ ...terminal.appearance.theme, foreground: { r: 0, g: 255, b: 0 } });
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

// Full headless Chromium finds no adapter with ANGLE on Vulkan; the headless shell does.
const channel = swiftShader ? undefined : 'chromium'
const env = swiftShader ? swiftShaderEnv() : undefined
const browser = await chromium.launch({ args, channel, env, headless: !hardware })
try {
  for (const backend of selected) {
    await checkBackend(backend, false)
    await checkBackend(backend, true)
    if (backend !== 'webgpu' && backend !== 'webgl2') continue
    await checkBackend(backend, false, true)
    await checkBackend(backend, true, true)
  }
} finally {
  await browser.close()
}

async function checkBackend(
  backend: (typeof backends)[number],
  bidi: boolean,
  worker = false,
): Promise<void> {
  console.log(`Checking built package with ${backend}, bidi=${bidi}, worker=${worker}`)
  const page = await browser.newPage()
  page.setDefaultTimeout(15_000)
  const errors: string[] = []
  const composeRequests: string[] = []
  const bidiRequests: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.startsWith('/dist/bidi/')) bidiRequests.push(path)
    if (path === '/canvas-compose.wasm') composeRequests.push(path)
    if (path === '/') {
      await route.fulfill({
        body: `<!doctype html><script type="importmap">${JSON.stringify({ imports })}</script><main style="width:640px;height:320px"></main>`,
        contentType: 'text/html',
      })
      return
    }
    if (path === imports['@fregat/hotkeys']) {
      await route.fulfill({ body: hotkeys, contentType: 'text/javascript' })
      return
    }
    if (path === '/smoke-font.ttf') {
      await route.fulfill({
        body: Buffer.from(
          await Bun.file(
            new URL(
              '../src/render/shared/atlas/sprite-fixtures/JetBrainsMono-Regular.ttf',
              import.meta.url,
            ),
          ).arrayBuffer(),
        ),
        contentType: 'font/ttf',
      })
      return
    }
    const allowed =
      path.startsWith('/dist/') ||
      path === '/ghostty-vt.wasm' ||
      path === '/bridge.wasm' ||
      path === '/canvas-compose.wasm'
    if (!allowed) return route.abort()
    const file = Bun.file(join(root, path))
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
      `Promise.race([${openScenario}(${JSON.stringify(backend)},${JSON.stringify(bidi)},${JSON.stringify(worker)}), new Promise((_, reject) => setTimeout(() => reject(new Error('Terminal smoke timed out')), 15000))])`,
    )
    assert(result && typeof result === 'object')
    assert('backend' in result && 'text' in result)
    assert.equal(result.backend, backend === 'canvas2d-pixels' ? 'canvas2d' : backend)
    assert.equal(composeRequests.length, backend === 'canvas2d-pixels' ? 1 : 0)
    assert.equal(typeof result.text, 'string')
    assert(String(result.text).includes('built-fallback-ok'))
    assert.equal(
      bidiRequests.some((path) => /\/(row|selection)\.js$/.test(path)),
      bidi,
      'Optional BiDi implementation loads only when enabled',
    )
    if (bidi) assert(String(result.text).includes('ab שלום cd'))
    await checkPresentation(page, backend)
    const selection: unknown = await page.evaluate(`(async () => {
      const terminal = globalThis.rendererSmokeTerminal;
      await terminal.selectAll();
      return await terminal.getSelection();
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

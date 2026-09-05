import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { platform, release } from 'node:os'
import { chromium, type Page } from 'playwright'
import { displayedInk } from '../displayed-ink'
import baseline from '../../docs/replacement/baseline.json'
import { bufferScenario, fitScenario, linksScenario, openScenario } from './scenarios'

const root = join(import.meta.dirname, '../..')
const output = join(root, '.artifacts/replacement')
const origin = 'http://127.0.0.1:41801'
const results: { package: string; workflow: string; status: 'pass' | 'fail'; detail: unknown }[] =
  []
const imports = {
  '@tanstack/hotkeys': '/node_modules/@tanstack/hotkeys/dist/index.js',
  '@tanstack/store': '/node_modules/@tanstack/store/dist/index.js',
}

async function verifyBaseline(): Promise<void> {
  const installed = await Bun.file(join(root, 'node_modules/ghostty-web/package.json')).json()
  assert.equal(installed.version, baseline.version)
  const response = await fetch(baseline.tarball)
  assert(response.ok, `Baseline tarball returned ${response.status}`)
  const archive = new Uint8Array(await response.arrayBuffer())
  const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`
  assert.equal(integrity, baseline.integrity)
  for (const file of ['dist/ghostty-web.js', 'dist/index.d.ts', 'ghostty-vt.wasm']) {
    const extracted = Bun.spawnSync(['tar', '-xzOf', '-', `package/${file}`], { stdin: archive })
    assert.equal(extracted.exitCode, 0, `Cannot inspect pinned baseline ${file}`)
    const installed = new Uint8Array(
      await Bun.file(join(root, 'node_modules/ghostty-web', file)).arrayBuffer(),
    )
    assert.equal(sha256(installed), sha256(extracted.stdout), `Installed baseline differs: ${file}`)
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function fingerprint(files: readonly string[]): Promise<string> {
  const entries = []
  for (const file of [...files].sort()) {
    const bytes = new Uint8Array(await Bun.file(join(root, file)).arrayBuffer())
    entries.push(`${file}\0${sha256(bytes)}`)
  }
  return sha256(new TextEncoder().encode(entries.join('\n')))
}

async function candidateFingerprint(): Promise<string> {
  const entries = await readdir(join(root, 'dist'), { withFileTypes: true, recursive: true })
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
  return fingerprint([...files, 'ghostty-vt.wasm', 'bridge.wasm'])
}

async function check(name: string, workflow: string, run: () => Promise<unknown>): Promise<void> {
  try {
    results.push({ package: name, workflow, status: 'pass', detail: await run() })
  } catch (error) {
    results.push({ package: name, workflow, status: 'fail', detail: String(error) })
  }
}

async function routePage(page: Page, name: string): Promise<void> {
  await page.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/baseline' || path === '/candidate') {
      await route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html>
        <script type="importmap">${JSON.stringify({ imports })}</script>
        ${name === 'candidate' ? '<link rel="stylesheet" href="/dist/xterm/xterm.css">' : ''}
        <main style="width:640px;height:320px"></main>`,
      })
      return
    }
    const allowed =
      path.startsWith('/dist/') ||
      path.startsWith('/node_modules/ghostty-web/') ||
      path.startsWith('/node_modules/@tanstack/') ||
      path === '/ghostty-vt.wasm' ||
      path === '/bridge.wasm'
    if (!allowed || path.includes('..')) return route.abort()
    const fileRoot =
      name === 'baseline' && path === '/ghostty-vt.wasm'
        ? join(root, 'node_modules/ghostty-web')
        : root
    const file = Bun.file(join(fileRoot, path))
    if (!(await file.exists())) return route.abort()
    const contentType = path.endsWith('.wasm') ? 'application/wasm' : file.type
    await route.fulfill({ body: Buffer.from(await file.arrayBuffer()), contentType })
  })
}

async function runWorkflows(page: Page, name: string): Promise<void> {
  await check(name, 'open-write', async () => {
    const grid = await page.evaluate(openScenario)
    assert.deepEqual(grid, { cols: 80, rows: 24 })
    return grid
  })
  await check(name, 'displayed-output-theme', async () => {
    const before = await displayedInk(page)
    assert(before.red > 20, 'Expected displayed red glyphs')
    await page.evaluate(
      "globalThis.fixture.terminal.options.theme = {foreground: '#00ff00', background: '#000000'}",
    )
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    const after = await displayedInk(page)
    await page.locator('main canvas').screenshot({ path: join(output, `${name}.png`) })
    assert(
      after.green > 20 && after.red === 0,
      `Expected recolored green glyphs without stale red glyphs: ${JSON.stringify({ before, after })}`,
    )
    return { before, after }
  })
  await check(name, 'keyboard-input', async () => {
    await page.keyboard.type('hello')
    const data = await page.evaluate('globalThis.fixture.data.join("")')
    assert.equal(data, 'hello')
    return data
  })
  await check(name, 'resize', async () => {
    const size = await page.evaluate(`(() => {
      const {terminal, resizes} = globalThis.fixture;
      terminal.resize(60, 12);
      return {cols: terminal.cols, rows: terminal.rows, event: resizes.at(-1)};
    })()`)
    assert.deepEqual(size, { cols: 60, rows: 12, event: { cols: 60, rows: 12 } })
    return size
  })
  await check(name, 'buffer-text-cell-cursor', async () => {
    const buffer = await page.evaluate(bufferScenario)
    assert.deepEqual(buffer, { text: 'replacement-ready', cell: 'r', cursorX: 17, cursorY: 0 })
    return buffer
  })
  await check(name, 'fit', () => page.evaluate(fitScenario))
  await check(name, 'custom-link-registration', () => page.evaluate(linksScenario))
  await check(name, 'dispose', async () => {
    await page.evaluate('globalThis.fixture.terminal.dispose()')
    assert.equal(await page.locator('main canvas').count(), 0)
    return 'canvas removed'
  })
}

await mkdir(output, { recursive: true })
for (const file of ['results.json', 'baseline.png', 'candidate.png']) {
  await rm(join(output, file), { force: true })
}
await verifyBaseline()
const builtSha256 = await candidateFingerprint()
const fixtureSha256 = await fingerprint([
  'scripts/replacement/compare.ts',
  'scripts/replacement/scenarios.ts',
  'scripts/displayed-ink.ts',
])
const browser = await chromium.launch({ channel: 'chromium', headless: true })
try {
  for (const name of ['baseline', 'candidate']) {
    const page = await browser.newPage({
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: 1,
    })
    page.setDefaultTimeout(15_000)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await routePage(page, name)
    // This run qualifies Canvas2D correctness, not hardware performance or WebGPU presentation.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true })
      const original = HTMLCanvasElement.prototype.getContext
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
        value(this: HTMLCanvasElement, kind: string, options?: object): unknown {
          if (kind === 'webgl2') return null
          return Reflect.apply(original, this, [kind, options])
        },
      })
    })
    await page.goto(`${origin}/${name}`)
    await runWorkflows(page, name)
    await check(name, 'uncaught-errors', async () => {
      assert.deepEqual(errors, [])
      return errors
    })
    await page.close()
  }
  assert.equal(
    await candidateFingerprint(),
    builtSha256,
    'Built candidate changed during comparison',
  )
  const commit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root }).stdout.toString().trim()
  const diff = Bun.spawnSync(['git', 'diff', 'HEAD'], { cwd: root }).stdout
  await Bun.write(
    join(output, 'results.json'),
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        baseline,
        fixtureSha256,
        candidate: {
          commit,
          builtSha256,
          trackedDiffSha256: createHash('sha256').update(diff).digest('hex'),
          dirty: Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: root }).stdout.toString(),
        },
        environment: {
          os: platform(),
          release: release(),
          browser: browser.version(),
          backend: 'canvas2d',
          headless: true,
          font: 'monospace 14px',
          dpr: 1,
          loading: 'built dist modules from checkout; not packed-consumer evidence',
          performance: 'unmeasured',
          physicalInput: 'unverified',
        },
        results,
      },
      null,
      2,
    ) + '\n',
  )
} finally {
  await browser.close()
}
console.table(
  results.map(({ package: name, workflow, status }) => ({ package: name, workflow, status })),
)
console.log(`Evidence: ${join(output, 'results.json')}`)
if (results.some((result) => result.status === 'fail')) process.exitCode = 1

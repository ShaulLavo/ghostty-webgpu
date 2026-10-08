import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { cpus, platform, release, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { chromium, type Page } from 'playwright'
import type { Request, Screen, Size, Variant } from './correctness-browser.js'
import { corpus, fixtureText } from '../bench/comparison-fixtures.js'

const upstreamCommit = '2798f12149a19c3295e9b4853ab2da4b2eff1b2b'
const root = resolve(import.meta.dirname, '..')
const output = resolve(process.argv[2] ?? join(root, '.artifacts/correctness'))
const reference = process.argv[3] ? resolve(process.argv[3]) : undefined
const variants: Variant[] = ['ghostty-webgpu', 'xterm.js', 'ghostty-web']
interface Result {
  variant: Variant
  suite: string
  name: string
  status: 'pass' | 'fail'
  detail: string
  inputHex?: string
  observed?: { lines: string[]; cursor: Screen['cursor']; replies: string }
}
const results: Result[] = []
const encoder = new TextEncoder()

async function request(page: Page, message: Request): Promise<Screen | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TypeError(`Browser operation timed out: ${message.op}`)),
      15_000,
    )
  })
  try {
    return await Promise.race([
      deadline,
      page.evaluate(async (message) => {
        const api = window as unknown as {
          correctness: (request: Request) => Promise<Screen | null>
        }
        return api.correctness(message)
      }, message),
    ])
  } finally {
    clearTimeout(timer)
  }
}
async function write(page: Page, text: string) {
  await request(page, { op: 'write', bytes: [...encoder.encode(text)] })
}
async function screen(page: Page): Promise<Screen> {
  const value = await request(page, { op: 'screen' })
  assert(value)
  return value
}

async function setupStep<T>(variant: Variant, step: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (cause) {
    throw new TypeError(`Failed to prepare ${variant}: ${step}`, { cause })
  }
}

async function adapterReady(page: Page, variant: Variant) {
  await setupStep(variant, 'adapter ready', () =>
    page.waitForFunction(
      () => typeof (window as unknown as { correctness?: unknown }).correctness === 'function',
    ),
  )
}

async function setupPage(page: Page, url: string, variant: Variant, size?: Size) {
  page.setDefaultTimeout(15_000)
  await setupStep(variant, 'navigation', () => page.goto(url))
  await adapterReady(page, variant)
  await setupStep(variant, 'terminal reset', () => request(page, { op: 'reset', variant, size }))
}

async function upstream(page: Page, checkout: string, variant: Variant) {
  const child = spawn(
    'python3',
    [join(root, 'scripts/correctness-esctest.py'), checkout, variant],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    },
  )
  let stderr = ''
  let inputHex = ''
  let suite: string | undefined
  child.stderr.on('data', (data) => {
    stderr += data
  })
  const exit = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      const message = JSON.parse(line) as Request | (Omit<Result, 'variant'> & { op: 'result' })
      if (message.op === 'reset') {
        if (message.suite !== suite) {
          await setupStep(variant, 'navigation', () => page.reload())
          await adapterReady(page, variant)
          suite = message.suite
        }
        await setupStep(variant, 'terminal reset', () => request(page, message))
        inputHex = ''
        child.stdin.write('{"value":null}\n')
        continue
      }
      try {
        if (message.op === 'write') inputHex += Buffer.from(message.bytes).toString('hex')
        if (message.op === 'result') {
          const { op: _, ...result } = message
          const observed = result.status === 'fail' ? await observe(page) : undefined
          results.push({ ...result, variant, inputHex, observed })
          child.stdin.write('{"value":null}\n')
          continue
        }
        const value = await request(page, message)
        child.stdin.write(JSON.stringify({ value }) + '\n')
      } catch (error) {
        child.stdin.write(JSON.stringify({ error: String(error) }) + '\n')
      }
    }
    assert.equal(await exit, 0, stderr)
  } finally {
    child.kill()
  }
}

async function observe(page: Page): Promise<Result['observed']> {
  const state = await screen(page).catch(() => undefined)
  if (!state) return undefined
  return {
    lines: state.cells.map((row) => row.join('').trimEnd()),
    cursor: state.cursor,
    replies: state.replies,
  }
}

async function caseResult(
  parent: Page,
  variant: Variant,
  suite: string,
  name: string,
  check: (page: Page) => Promise<void>,
  size?: Size,
  url = parent.url(),
) {
  const page = await setupStep(variant, 'new context', () => parent.context().browser()!.newPage())
  try {
    await setupPage(page, url, variant, size)
    await checkCase(page, variant, suite, name, check)
  } finally {
    await page.close().catch(() => {})
  }
}

async function checkCase(
  page: Page,
  variant: Variant,
  suite: string,
  name: string,
  check: (page: Page) => Promise<void>,
) {
  try {
    await check(page)
    results.push({ variant, suite, name, status: 'pass', detail: '' })
  } catch (error) {
    const observed = await observe(page)
    results.push({ variant, suite, name, status: 'fail', detail: String(error), observed })
  }
}

const unicode = [
  { name: 'CJK', text: '日本語中文', width: 10 },
  { name: 'combining', text: 'é', width: 1 },
  { name: 'emoji', text: '🧪', width: 2 },
  { name: 'skin tone', text: '👍🏽', width: 2 },
  { name: 'ZWJ', text: '👩‍💻', width: 2 },
  { name: 'family', text: '👨‍👩‍👧‍👦', width: 2 },
  { name: 'flag', text: '🇺🇸', width: 2 },
  { name: 'VS16', text: '❤️', width: 2 },
]

async function deliver(page: Page, text: string, oneByte: boolean) {
  const bytes = [...encoder.encode(text)]
  const chunks = oneByte ? bytes.map((byte) => [byte]) : [bytes]
  for (const chunk of chunks) await request(page, { op: 'write', bytes: chunk })
}

async function custom(page: Page, variant: Variant) {
  for (const fixture of unicode) {
    for (const split of [false, true]) {
      const suffix = split ? 'one byte' : 'whole'
      await caseResult(page, variant, 'unicode-text', `${fixture.name} ${suffix}`, async (page) => {
        await write(page, '\x1b[?2027h')
        await deliver(page, fixture.text, split)
        await request(page, { op: 'settle' })
        const actual = await screen(page)
        assert.equal(actual.cells[0]!.join('').trimEnd(), fixture.text)
      })
      await caseResult(
        page,
        variant,
        'grapheme-width',
        `${fixture.name} ${suffix}`,
        async (page) => {
          await write(page, '\x1b[?2027h')
          await deliver(page, fixture.text, split)
          assert.deepEqual((await screen(page)).cursor, { x: fixture.width, y: 0 })
        },
      )
    }
  }
  await caseResult(page, variant, 'delivery', 'CSI one byte', async (page) => {
    await deliver(page, '\x1b[3;7HOK', true)
    const actual = await screen(page)
    assert.equal(actual.cells[2]!.slice(6, 8).join(''), 'OK')
    assert.deepEqual(actual.cursor, { x: 8, y: 2 })
  })
  await caseResult(page, variant, 'delivery', 'empty byte write', async (page) => {
    await request(page, { op: 'write', bytes: [] })
    assert.deepEqual((await screen(page)).cursor, { x: 0, y: 0 })
  })
  await caseResult(page, variant, 'reports', 'DSR status', async (page) => {
    await write(page, '\x1b[5n')
    assert.equal((await screen(page)).replies, '\x1b[0n')
  })
  await caseResult(page, variant, 'reports', 'DSR position', async (page) => {
    await write(page, '\x1b[4;9H\x1b[6n')
    assert.equal((await screen(page)).replies, '\x1b[4;9R')
  })
  await caseResult(
    page,
    variant,
    'unicode-burst',
    'benchmark 4 KiB x 32 frames',
    async (page) => {
      const payload = corpus(fixtureText('unicode', ''), 4096)
      await write(page, '\x1b[3J\x1b[2J\x1b[H')
      for (let index = 0; index < 32; index++) {
        await write(page, payload)
        await request(page, { op: 'settle' })
      }
      const text = (await screen(page)).cells.map((row) => row.join('')).join('\n')
      assert(text.includes('日本語'))
      assert(text.includes('🧪'))
    },
    { columns: 40, rows: 12 },
  )
}

async function calibration(page: Page, variant: Variant) {
  await write(page, 'ABC')
  const actual = await screen(page)
  assert.equal(actual.cells[0]!.slice(0, 3).join(''), 'ABC', `${variant}: ASCII text calibration`)
  assert.deepEqual(actual.cursor, { x: 3, y: 0 })
  assert.throws(() => assert.equal(actual.cells[0]![0], 'WRONG'))
  assert.throws(() => assert.deepEqual(actual.cursor, { x: 4, y: 0 }))
}

async function setupControls(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  checkout: string,
) {
  const parent = await browser.newPage()
  const before = results.length
  let checked = false
  const controls = [
    { step: 'navigation', url: 'http://127.0.0.1:0/' },
    { step: 'adapter ready', url: 'data:text/html,<p>Missing adapter</p>' },
    {
      step: 'terminal reset',
      url: 'data:text/html,<script>window.correctness=async()=>{throw new TypeError("Broken adapter")}</script>',
    },
  ]
  try {
    for (const control of controls) {
      await assert.rejects(
        () =>
          caseResult(
            parent,
            'xterm.js',
            'setup-control',
            control.step,
            async () => {
              checked = true
            },
            undefined,
            control.url,
          ),
        (error: unknown) =>
          error instanceof TypeError && error.message.includes(`xterm.js: ${control.step}`),
      )
      assert.equal(results.length, before, 'Setup failures must never produce terminal results')
      assert.equal(checked, false, 'Setup failures must abort before the case body')
    }
    await parent.goto(controls[2]!.url)
    await assert.rejects(
      () => upstream(parent, checkout, 'xterm.js'),
      (error: unknown) =>
        error instanceof TypeError && error.message.includes('xterm.js: terminal reset'),
    )
    assert.equal(results.length, before, 'Upstream setup failure must abort without case results')
  } finally {
    await parent.close()
  }
  console.log(
    'Setup controls: navigation, missing adapter and broken reset rejected; upstream reset rejected',
  )
}

async function main() {
  await mkdir(output, { recursive: true })
  const scratch = await mkdtemp(join(tmpdir(), 'ghostty-correctness-'))
  let server: ReturnType<typeof Bun.serve> | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    const checkout = reference ?? join(scratch, 'esctest2')
    if (!reference)
      execFileSync('git', [
        'clone',
        '--quiet',
        'https://github.com/ThomasDickey/esctest2.git',
        checkout,
      ])
    if (!reference) execFileSync('git', ['checkout', '--quiet', upstreamCommit], { cwd: checkout })
    assert.equal(
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim(),
      upstreamCommit,
    )
    assert.equal(
      execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
        cwd: checkout,
        encoding: 'utf8',
      }).trim(),
      '',
      'esctest2 checkout must be unmodified',
    )
    const build = await Bun.build({
      entrypoints: [join(root, 'scripts/correctness-browser.ts')],
      outdir: scratch,
      target: 'browser',
      naming: 'browser.js',
    })
    assert(build.success, build.logs.join('\n'))
    await cp(join(root, 'ghostty-vt.wasm'), join(scratch, 'native.wasm'))
    await cp(join(root, 'bridge.wasm'), join(scratch, 'bridge.wasm'))
    const legacyRoot = dirname(require.resolve('ghostty-web/package.json'))
    await cp(join(legacyRoot, 'ghostty-vt.wasm'), join(scratch, 'legacy.wasm'))
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => {
        const name = new URL(request.url).pathname.slice(1)
        if (name === '')
          return new Response(
            '<!doctype html><div id="terminal"></div><script type="module" src="/browser.js"></script>',
            {
              headers: { 'content-type': 'text/html' },
            },
          )
        if (!['browser.js', 'native.wasm', 'legacy.wasm', 'bridge.wasm'].includes(name))
          return new Response('', { status: 404 })
        return new Response(Bun.file(join(scratch, name)))
      },
    })
    browser = await chromium.launch({ headless: true })
    await setupControls(browser, checkout)
    for (const variant of variants) {
      const page = await setupStep(variant, 'new context', () => browser!.newPage())
      await setupPage(page, `http://127.0.0.1:${server.port}`, variant)
      await calibration(page, variant)
      await upstream(page, checkout, variant)
      console.log(`${variant}: esctest2 completed`)
      await writeFile(join(output, 'partial-results.json'), JSON.stringify(results, null, 2) + '\n')
      await custom(page, variant)
      console.log(`${variant}: custom cases completed`)
      await page.close()
    }
    for (const variant of variants) {
      const rows = results.filter((row) => row.variant === variant)
      assert.equal(rows.length, 169, 'Every pinned test must produce a result')
      assert.equal(new Set(rows.map((row) => `${row.suite}/${row.name}`)).size, 169)
    }
    const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    const xtermPackage = JSON.parse(
      await readFile(require.resolve('@xterm/xterm/package.json'), 'utf8'),
    )
    const legacyPackage = JSON.parse(await readFile(join(legacyRoot, 'package.json'), 'utf8'))
    assert.equal(xtermPackage.version, '6.0.0', 'Comparison pins xterm.js 6.0.0')
    assert.equal(legacyPackage.version, '0.4.0', 'Comparison pins ghostty-web 0.4.0')
    const artifact = {
      date: new Date().toISOString(),
      upstreamCommit,
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      versions: {
        'ghostty-webgpu': metadata.version,
        'xterm.js': xtermPackage.version,
        'ghostty-web': legacyPackage.version,
        playwright: metadata.devDependencies.playwright,
        chromium: browser.version(),
      },
      machine: { platform: platform(), release: release(), cpu: cpus()[0]?.model },
      assets: Object.fromEntries(
        await Promise.all(
          Object.entries({
            'ghostty-vt.wasm': join(root, 'ghostty-vt.wasm'),
            'bridge.wasm': join(root, 'bridge.wasm'),
            'legacy.wasm': join(legacyRoot, 'ghostty-vt.wasm'),
            'browser.js': join(scratch, 'browser.js'),
            'correctness-esctest.py': join(root, 'scripts/correctness-esctest.py'),
          }).map(async ([name, path]) => [
            name,
            createHash('sha256')
              .update(await readFile(path))
              .digest('hex'),
          ]),
        ),
      ),
      calibration:
        'ASCII text and cursor passed; deliberately wrong text and cursor rejected on every terminal',
      setupControls:
        'Navigation failure, missing adapter and broken reset abort without results; upstream broken reset aborts without results',
      results,
    }
    await writeFile(join(output, 'results.json'), JSON.stringify(artifact, null, 2) + '\n')
    for (const variant of variants) {
      const rows = results.filter((result) => result.variant === variant)
      console.log(
        `${variant}: ${rows.filter((row) => row.status === 'pass').length}/${rows.length} passed`,
      )
    }
    console.log(`Results: ${join(output, 'results.json')}`)
    // Exit status covers runner integrity. Every conformance failure is in results.json.
  } finally {
    await browser?.close()
    server?.stop(true)
    await rm(scratch, { recursive: true, force: true })
  }
}

await main()

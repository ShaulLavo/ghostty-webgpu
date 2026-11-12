import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attach } from 'webdriverio'
import { PNG } from 'pngjs'
import { test, vi, beforeAll, afterAll } from 'vitest'
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
const previousDispatcher = getGlobalDispatcher()
const dispatcher = new Agent()
beforeAll(() => setGlobalDispatcher(dispatcher))
afterAll(async () => {
  await dispatcher.close()
  setGlobalDispatcher(previousDispatcher)
})
import { chromium } from 'playwright'
import { transformWithOxc } from 'vite'
import { enclosingDeviceCapture } from './ios-browser-capture.ts'
import * as geometryModule from './ios-browser-capture-geometry.ts'
import {
  writeCaptureDiagnostic,
  type DiagnosticObservation,
} from './ios-browser-capture-diagnostic.ts'

const geometry: geometryModule.CaptureGeometry = {
  element: { left: 30.5, top: 30.5, right: 72.5, bottom: 56.5 },
  tester: {
    scrollX: 0,
    scrollY: 0,
    width: 414,
    height: 896,
    dpr: 3,
    visual: { offsetLeft: 0, offsetTop: 0, scale: 1 },
  },
  frame: { left: 0, top: 0, width: 414, height: 896, cornersHitFrame: true },
  top: {
    scrollX: 0,
    scrollY: 0,
    dpr: 3,
    visual: { offsetLeft: 0, offsetTop: 0, width: 390, height: 699, scale: 1 },
  },
}
const options = {
  element: { selector: '#capture-control', locator: null },
  scale: 'device',
  save: false,
} as const
const rect = { x: 0, y: 0, width: 390, height: 844 }

async function transport(execute: (script: string, args: unknown[]) => Promise<unknown>) {
  const requests: string[] = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += String(chunk)
    const input: unknown = body ? JSON.parse(body) : null
    requests.push(request.url ?? '')
    let value: unknown = null
    if (request.url?.endsWith('/element'))
      value = { 'element-6066-11e4-a52e-4f735466cecf': 'target' }
    if (request.url?.endsWith('/execute/sync')) {
      assert(
        input && typeof input === 'object' && 'script' in input && typeof input.script === 'string',
      )
      const args = 'args' in input && Array.isArray(input.args) ? input.args : []
      value = await execute(input.script, args)
    }
    if (request.url?.endsWith('/window/rect')) value = rect
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ value }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const browser = await attach({
    sessionId: 'diagnostic-control',
    capabilities: { browserName: 'safari' },
    hostname: '127.0.0.1',
    port: address.port,
    path: '/',
    logLevel: 'silent',
    isW3C: true,
  })
  return {
    browser,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}

function generatedPng(height: number): Buffer {
  const image = new PNG({ width: 1170, height })
  image.data.fill(255)
  return PNG.sync.write(image)
}

test('rejected raw PNG persists once, with stable geometry, metrics and the original planner error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gcd-'))
  const wire = await transport(async (script) =>
    script.includes('function measureCapture(') ? geometry : null,
  )
  const rows: DiagnosticObservation[] = []
  const raw = generatedPng(2532)
  const planned = new geometryModule.UnsupportedCapture('Exact planner object')
  const original = geometryModule.planEnclosingCrop
  const spy = vi.spyOn(geometryModule, 'planEnclosingCrop').mockImplementation((before, info) => {
    if (info.height === 2532) throw planned
    return original(before, info)
  })
  let observed = 0
  try {
    await assert.rejects(
      () =>
        enclosingDeviceCapture(async () => ({ buffer: raw, path: '/official-removed.png' }), {
          browser: wire.browser,
          testerSelected: true,
          options,
          observe: () => observed++,
          diagnose: (evidence) => rows.push({ name: 'failure', evidence }),
        }),
      (error) => error === planned,
    )
    assert.equal(rows.length, 1)
    assert.equal(observed, 0)
    const evidence = rows[0]!.evidence
    assert(evidence.kind === 'captured')
    assert.equal(evidence.raw, raw)
    assert.deepEqual(evidence.before, evidence.after)
    assert.deepEqual(evidence.metrics.windowRect, rect)
    assert.equal(wire.requests.filter((path) => path.endsWith('/window/rect')).length, 1)
    const path = join(directory, 'failure.json')
    await writeCaptureDiagnostic(path, rows)
    assert.deepEqual(await readFile(`${path}.viewport.png`), raw)
    const saved = JSON.parse(await readFile(`${path}.diagnostic.json`, 'utf8'))
    assert.equal(saved[0].evidence.raw.sha256, createHash('sha256').update(raw).digest('hex'))
    assert.equal((await stat(`${path}.viewport.png`)).mode & 0o777, 0o600)
    await assert.rejects(() => writeCaptureDiagnostic(path, rows), /EEXIST/)
  } finally {
    spy.mockRestore()
    await wire.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('success diagnoses once; official rejection retains identity without a successful observation', async () => {
  const wire = await transport(async (script) =>
    script.includes('function measureCapture(') ? geometry : null,
  )
  const rows: DiagnosticObservation[] = []
  const raw = generatedPng(2097)
  let observations = 0
  const request = {
    browser: wire.browser,
    testerSelected: true,
    options,
    observe: () => observations++,
    diagnose: (evidence: DiagnosticObservation['evidence']) =>
      rows.push({ name: 'case', evidence }),
  }
  try {
    const result = await enclosingDeviceCapture(
      async () => ({ buffer: raw, path: 'official.png' }),
      request,
    )
    assert.equal(result.path, 'official.png')
    assert.equal(rows.length, 1)
    assert.equal(observations, 1)
    assert.equal(rows[0]!.evidence.kind, 'captured')
    rows.length = 0
    const error = new Error('official failure')
    await assert.rejects(
      () =>
        enclosingDeviceCapture(async () => {
          throw error
        }, request),
      (actual) => actual === error,
    )
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.evidence.kind, 'official-rejected')
    assert.equal(observations, 1)
  } finally {
    await wire.close()
  }
})

async function browserSource(path: string): Promise<string> {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  return (await transformWithOxc(source, path)).code
    .replace(/^import.*\n/gm, '')
    .replace(/^export /gm, '')
}

test('actual diagnostic file succeeds once in local Chromium and writes genuine sidecars', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gcd-'))
  const browser = await chromium.launch({ headless: true })
  let wire: Awaited<ReturnType<typeof transport>> | undefined
  try {
    const page = await browser.newPage({
      viewport: { width: 414, height: 896 },
      deviceScaleFactor: 3,
    })
    await page.setContent(
      '<style>body{margin:0}iframe{border:0;width:414px;height:896px}</style><iframe srcdoc="<!doctype html><body></body>"></iframe>',
    )
    const frame = page.frames().find((item) => item !== page.mainFrame())
    assert(frame)
    wire = await transport(async (script, args) =>
      frame.evaluate(
        ({ script, args }) => {
          const values = args.map((value) =>
            typeof value === 'object' &&
            value !== null &&
            'element-6066-11e4-a52e-4f735466cecf' in value
              ? document.querySelector('#capture-control')
              : value,
          )
          return new Function(script).apply(window, values)
        },
        { script, args },
      ),
    )
    const rows: DiagnosticObservation[] = []
    const attached = wire.browser
    await page.exposeFunction('__capture', async () => {
      const result = await enclosingDeviceCapture(
        async () => ({
          buffer: await page.screenshot({ scale: 'device' }),
          path: 'local-only.png',
        }),
        {
          browser: attached,
          testerSelected: true,
          options,
          diagnose: (evidence) => rows.push({ name: 'local diagnostic', evidence }),
        },
      )
      return result.buffer.toString('base64')
    })
    const fixture = await browserSource('./ios-browser-capture-fixture.ts')
    const bands = await browserSource('./ios-browser-capture-diagnostic-fixture.ts')
    const actual = await browserSource('./ios-browser-capture-diagnostic.browser.test.ts')
    await frame.evaluate(
      async (source) => new Function(`return (async () => { ${source} })()`)(),
      `
let selected; let cleanup;
const afterEach = (fn) => { cleanup = fn }; const describe = (_name, fn) => fn(); const test = (_name, fn) => { selected = fn };
const expect = (value) => ({ toEqual(expected) { if (JSON.stringify(value) !== JSON.stringify(expected)) throw new Error(JSON.stringify({value,expected})) } });
const pixel = (data, width, x, y) => Array.from(data.subarray((y*width+x)*4,(y*width+x)*4+4));
const page = { screenshot: () => window.__capture() };
${fixture}\n${bands}\n${actual}\ntry { await selected(); } finally { cleanup(); }`,
    )
    assert.equal(rows.length, 1)
    await writeCaptureDiagnostic(join(directory, 'local.json'), rows)
    const destination = process.env.GHOSTTY_DIAGNOSTIC_LOCAL
    if (destination) {
      await writeFile(
        join(destination, 'local.json.diagnostic.json'),
        await readFile(join(directory, 'local.json.diagnostic.json')),
        { flag: 'wx', mode: 0o600 },
      )
      await writeFile(
        join(destination, 'local.json.viewport.png'),
        await readFile(join(directory, 'local.json.viewport.png')),
        { flag: 'wx', mode: 0o600 },
      )
    }
  } finally {
    await browser.close()
    await wire?.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

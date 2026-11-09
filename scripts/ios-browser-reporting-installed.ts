import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, type Page, type Frame, type BrowserContext, type Route } from 'playwright'
import { createVitest } from 'vitest/node'
import type { Plugin, ViteDevServer } from 'vite'
import { createFrameworkControl } from 'waffle/testing/page-runner/framework'
import { attachedGhosttyProvider, ghosttyFrameworkPlugin } from './ios-browser.ts'
import { reportingSyntheticNames, reportingFullName } from './ios-browser-reporting-manifest.ts'
import { frameworkEndReporter } from './ios-browser-report.ts'
import { runFrameworkNode, joinFrameworkExecution } from './ios-browser-node.ts'

type Mode = 'matrix' | 'errors' | 'flush' | 'capacity' | 'malformed'
function modeFromArguments(): Mode {
  if (process.argv.includes('--malformed')) return 'malformed'
  if (process.argv.includes('--capacity')) return 'capacity'
  if (process.argv.includes('--errors')) return 'errors'
  if (process.argv.includes('--flush')) return 'flush'
  return 'matrix'
}
const mode = modeFromArguments()
const errorsMode = mode === 'errors' || mode === 'capacity' || mode === 'malformed'
const flushMode = mode === 'flush'
const errorNames = [
  'reporting refusal remains infrastructure only',
  'official update and both error paths survive reporting refusal',
  'official update returns its original result after refusal',
]
const fixtures = {
  matrix: {
    file: 'scripts/ios-browser-reporting.synthetic.browser.test.ts',
    names: reportingSyntheticNames.map(reportingFullName),
    gates: [
      'collected',
      'suite-start',
      'task-started',
      'case-settled',
      'execution-flushed',
      'tester-cleanup-settled',
      'cleanup-response-received',
    ],
  },
  errors: {
    file: 'scripts/ios-browser-reporting-errors.synthetic.browser.test.ts',
    names: errorNames,
    gates: [],
  },
  capacity: {
    file: 'scripts/ios-browser-reporting-errors.synthetic.browser.test.ts',
    names: errorNames,
    gates: [],
  },
  malformed: {
    file: 'scripts/ios-browser-reporting-errors.synthetic.browser.test.ts',
    names: errorNames,
    gates: [],
  },
  flush: {
    file: 'scripts/ios-browser-reporting-flush.synthetic.browser.test.ts',
    names: ['real throttling and final flush retain separate RPC and ACK owners'],
    gates: ['task-update', 'execution-flushed'],
  },
}
const selected = fixtures[mode]
const file = resolve(selected.file)
const names = selected.names
const output = process.env.GHOSTTY_REPORTING_EVIDENCE
if (!output) throw new Error('GHOSTTY_REPORTING_EVIDENCE is required')
const trace: unknown[] = []
const held = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
const reached = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
for (const kind of selected.gates) {
  held.set(kind, Promise.withResolvers<void>())
  reached.set(kind, Promise.withResolvers<void>())
}

let page: Page | undefined
let active: Page | Frame | undefined
let context: Awaited<ReturnType<typeof createVitest>> | undefined
const servers = new Set<ViteDevServer>()
let browserContext: BrowserContext | undefined
let running: Promise<unknown> | undefined
let reportTasks: unknown[] = []
let routeFailure: { reason: unknown } | undefined

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}
async function readBody(request: IncomingMessage): Promise<unknown> {
  let text = ''
  for await (const chunk of request) text += String(chunk)
  return text ? JSON.parse(text) : null
}
async function execute(payload: unknown): Promise<unknown> {
  if (!object(payload) || typeof payload.script !== 'string' || !active)
    throw new Error('Bad synthetic WebDriver script')
  return active.evaluate(
    ({ script, args }) => {
      const result: unknown = new Function(script).apply(null, args)
      if (objectResult(result) && result.frame instanceof HTMLIFrameElement)
        return { ...result, frame: { 'element-6066-11e4-a52e-4f735466cecf': 'synthetic-frame' } }
      return result
      function objectResult(value: unknown): value is Record<string, unknown> {
        return value !== null && typeof value === 'object'
      }
    },
    { script: payload.script, args: Array.isArray(payload.args) ? payload.args : [] },
  )
}
async function answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = request.url ?? '/'
  const payload = await readBody(request)
  trace.push({ request: request.method, path, payload })
  let value: unknown = null
  if (path === '/session')
    value = {
      sessionId: 'synthetic',
      capabilities: {
        browserName: 'Safari',
        browserVersion: 'Chromium synthetic transport, not native',
        platformName: 'iOS',
        'safari:useSimulator': true,
        'safari:deviceUDID': 'synthetic',
      },
    }
  if (path.endsWith('/context')) {
    response.statusCode = 405
    value = { error: 'unknown command', message: 'Synthetic HTTP only', stacktrace: '' }
  }
  if (path.endsWith('/window')) value = 'synthetic-window'
  if (path.endsWith('/window/handles')) value = ['synthetic-window']
  if (path.endsWith('/url') && object(payload) && typeof payload.url === 'string') {
    await page?.goto(payload.url, { waitUntil: 'domcontentloaded' })
    active = page
  }
  if (path.endsWith('/elements'))
    value = [{ 'element-6066-11e4-a52e-4f735466cecf': 'synthetic-frame' }]
  if (path.endsWith('/element'))
    value = { 'element-6066-11e4-a52e-4f735466cecf': 'synthetic-frame' }
  if (path.endsWith('/element/synthetic-frame/name')) value = 'iframe'
  if (path.endsWith('/frame')) {
    const frame = await page?.locator('iframe[data-vitest]').elementHandle()
    active =
      object(payload) && payload.id !== null ? ((await frame?.contentFrame()) ?? undefined) : page
  }
  if (path.endsWith('/frame/parent')) active = page
  if (path.endsWith('/execute/sync')) value = await execute(payload)
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify({ value }))
}
const fake = createServer((request, response) => {
  void answer(request, response).catch((reason) => {
    trace.push({ transportError: String(reason) })
    response.statusCode = 500
    response.end(
      JSON.stringify({
        value: { error: 'unknown error', message: String(reason), stacktrace: '' },
      }),
    )
  })
})
async function ownedReportRoute(route: Route): Promise<void> {
  try {
    await routeReport(route)
  } catch (reason) {
    routeFailure ??= { reason }
    trace.push({ reportTransportUncertainty: String(reason) })
    await route.abort().catch(() => {})
  }
}
async function routeReport(route: Route): Promise<void> {
  const body: unknown = route.request().postDataJSON()
  const response = await route.fetch()
  trace.push({ report: body, status: response.status() })
  const event = object(body) && object(body.event) ? body.event : undefined
  if (event?.kind === 'collected' && Array.isArray(event.tasks)) reportTasks = event.tasks
  let kind = event?.kind
  if (kind === 'task-started' && !flushMode) {
    const task = reportTasks.find((task) => object(task) && task.id === event?.id)
    if (object(task) && task.type !== 'test') kind = 'suite-start'
  }
  const flush = flushMode && kind === 'task-update' ? (await state())?.flush : undefined
  const canHold = !flushMode || kind !== 'task-update' || flush?.rpcHeld === true
  if (typeof kind === 'string' && held.has(kind) && canHold) {
    const gate = held.get(kind)
    held.delete(kind)
    reached.get(kind)?.resolve()
    await gate?.promise
  }
  if (mode === 'malformed' && event?.kind === 'task-update') {
    await route.fulfill({ response, body: JSON.stringify({ ackedThrough: -1 }) })
    return
  }
  await route.fulfill({ response })
}
async function state() {
  assert(page)
  const frame = page.frames().find((item) => item !== page?.mainFrame())
  return frame?.evaluate(() => ({
    bodies: Reflect.get(globalThis, '__reportingBodies'),
    messages: Reflect.get(globalThis, '__reportingMessages'),
    errorTrace: Reflect.get(globalThis, '__reportingErrorTrace'),
    flush: Reflect.get(globalThis, '__reportingFlush'),
    clocks: Reflect.get(globalThis, '__reportingClocks'),
    hooks: Reflect.get(globalThis, '__reportingHooks'),
    snapshot: Reflect.get(globalThis, '__waffleFramework')?.snapshot(),
  }))
}
const releases = new Map(held)
async function gates(): Promise<void> {
  for (const kind of reached.keys()) {
    await reached.get(kind)?.promise
    const before = await state()
    trace.push({ held: kind, state: before })
    assert(before)
    assert(Array.isArray(before.bodies))
    if (kind === 'collected' || kind === 'suite-start' || kind === 'task-started')
      assert.equal(before.bodies.length, 0)
    if (kind === 'case-settled') assert.equal(before.bodies.length, 1)
    if (kind === 'execution-flushed') assert(!before.messages.includes('response:execute'))
    if (kind === 'tester-cleanup-settled') assert(!before.messages.includes('response:cleanup'))
    if (kind === 'cleanup-response-received') assert(before.messages.includes('response:cleanup'))
    await delay(60)
    assert.deepEqual(
      (await state())?.bodies,
      before.bodies,
      `Held ${kind} must retain the lifecycle barrier`,
    )
    releases.get(kind)?.resolve()
  }
}

async function waitForControl(check: () => Promise<boolean>): Promise<void> {
  for (let turn = 0; turn < 200; turn++) {
    if (await check()) return
    await delay(5)
  }
  throw new Error('Installed synthetic boundary not reached')
}
async function flushGates(): Promise<void> {
  await reached.get('task-update')?.promise
  await waitForControl(async () => (await state())?.flush?.bodyFinished === true)
  const heldState = await state()
  trace.push({ independentHolds: heldState })
  assert.equal(heldState?.flush?.rpcReleased, false)
  releases.get('task-update')?.resolve()
  await waitForControl(async () =>
    trace.some(
      (item) =>
        object(item) &&
        object(item.report) &&
        object(item.report.event) &&
        item.report.event.kind === 'case-settled',
    ),
  )
  assert(
    !trace.some(
      (item) =>
        object(item) &&
        object(item.report) &&
        object(item.report.event) &&
        item.report.event.kind === 'execution-flushed',
    ),
  )
  assert(!(await state())?.messages.includes('response:execute'))
  const tester = page?.frames().find((frame) => frame !== page?.mainFrame())
  assert(tester)
  await tester.evaluate(() => {
    const release: unknown = Reflect.get(globalThis, '__reportingReleaseRpc')
    if (typeof release !== 'function') throw new Error('Missing original RPC release')
    release()
  })
  await reached.get('execution-flushed')?.promise
  trace.push({ afterOriginalFlush: await state() })
  releases.get('execution-flushed')?.resolve()
}

function ownedPlugin(): Plugin {
  return {
    name: 'owned-synthetic-vite',
    configureServer(server) {
      servers.add(server)
      server.middlewares.use(realmAsset)
    },
    transform(code, id) {
      if (
        !errorsMode ||
        !id.includes('/tester-') ||
        !code.includes('function unhandledError(e, type)')
      )
        return
      trace.push({ exposedInstalledTester: id })
      return (
        code +
        '\nReflect.set(globalThis, Symbol.for("ghostty.synthetic.tester-errors"), { unhandledError, client });\n'
      )
    },
  }
}
function realmAsset(
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void,
): void {
  if (request.url === '/__ghostty_reporting_realm.html') {
    response.setHeader('Content-Type', 'text/html')
    response.end('<!doctype html><html><head></head><body></body></html>')
    return
  }
  if (request.url !== '/__ghostty_reporting_bootstrap.js') {
    next()
    return
  }
  response.setHeader('Content-Type', 'application/javascript')
  const path = fileURLToPath(
    new URL(
      './framework-bootstrap.js',
      import.meta.resolve('waffle/testing/page-runner/framework'),
    ),
  )
  void readFile(path, 'utf8').then((script) => response.end(script), next)
}

function installTrace(): void {
  Reflect.set(globalThis, '__reportingBodies', [])
  Reflect.set(globalThis, '__reportingHooks', [])
  Reflect.set(globalThis, '__reportingClocks', [])
  const messages: string[] = []
  Reflect.set(globalThis, '__reportingMessages', messages)
  const original = BroadcastChannel.prototype.postMessage
  BroadcastChannel.prototype.postMessage = function (message: unknown) {
    if (
      message &&
      typeof message === 'object' &&
      'event' in message &&
      typeof message.event === 'string'
    )
      messages.push(message.event)
    return Reflect.apply(original, this, [message])
  }
}
function releaseReports(): void {
  for (const gate of releases.values()) gate.resolve()
}
async function closeOwnedContext(): Promise<void> {
  releaseReports()
  for (const gate of reached.values()) gate.resolve()
  await context?.close()
}

await runFrameworkNode(async () => {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  let host: ReturnType<typeof createFrameworkControl> | undefined
  let control: Promise<void> | undefined
  let watchdog: ReturnType<typeof setTimeout> | undefined
  try {
    browserContext = await browser.newContext({ viewport: { width: 414, height: 896 } })
    await browserContext.addInitScript(installTrace)
    await browserContext.addInitScript(
      (mode) => Reflect.set(globalThis, '__reportingRefusalMode', mode),
      mode,
    )
    await browserContext.route('**/report', ownedReportRoute)
    page = await browserContext.newPage()
    page.on('pageerror', (error) => trace.push({ pageerror: error.message }))
    page.on('console', (message) => trace.push({ console: message.type(), text: message.text() }))
    fake.listen(19761, '127.0.0.1')
    await once(fake, 'listening')
    host = createFrameworkControl(
      {
        suite: 'ghostty-reporting-installed-synthetic',
        native: { udid: 'synthetic' },
        expected: names.map((fullName, index) => ({
          file,
          fullName,
          sourceKey: `synthetic:${index}`,
          timeoutMs: 15000,
          retries: 0,
        })),
        scope: { kind: 'root-selection', command: 'test:browser', files: [file] },
        resultPath: `${output}/host-result.json`,
      },
      'http://127.0.0.1:19761/',
    )
    const ownedHost = host
    const end = frameworkEndReporter()
    watchdog = setTimeout(() => {
      void ownedHost.abort('Finite installed synthetic control deadline')
    }, 25000)
    const result = await host.run(async (registerClose) => {
      context = await createVitest(
        'test',
        { config: false, watch: false, root: process.cwd() },
        {
          plugins: [ghosttyFrameworkPlugin(ownedHost), ownedPlugin()],
          server: { port: 19762, strictPort: true },
          test: {
            include: [file],
            testTimeout: 15000,
            hookTimeout: 30000,
            retry: 0,
            isolate: true,
            fileParallelism: false,
            reporters: ['default', end.reporter],
            api: { port: 19763, strictPort: true },
            browser: {
              enabled: true,
              provider: attachedGhosttyProvider(ownedHost),
              instances: [{ browser: 'safari' }],
              headless: false,
              ui: false,
              screenshotFailures: false,
              viewport: { width: 414, height: 896 },
              commands: {},
            },
          },
        },
      )
      registerClose(closeOwnedContext)
      control = flushMode ? flushGates() : gates()
      void control.catch(releaseReports)
      running = context.start([file])
      await running
      await control
      return end.endStatus()
    })
    trace.push({ result })
    if (errorsMode) {
      assert.equal(result.exit, 2)
      assert.equal(result.fileComplete, false)
      const actual = await state()
      trace.push({ errorPathState: actual })
      assert.equal(
        result.framework?.status,
        'passed',
        'Reporting refusal must not change ordinary task outcomes',
      )
      assert(actual && Array.isArray(actual.errorTrace))
      const errors = actual.errorTrace.filter(
        (item: unknown) =>
          object(item) && item.kind === 'rpc' && item.source !== 'Synthetic capacity error',
      )
      assert.deepEqual(
        errors.map((item: Record<string, unknown>) => item.source),
        ['Synthetic tester error', 'Error', 'Cleanup Error'],
      )
      assert(
        actual.errorTrace.some(
          (item: unknown) => object(item) && item.kind === 'update-after-refusal',
        ),
      )
      return
    }
    if (routeFailure) throw routeFailure.reason
    assert.equal(result.exit, 4)
    assert.deepEqual(result.failures, [])
    assert.equal(result.framework?.status, 'passed', 'Synthetic case failures must remain visible')
    assert.equal(
      reportTasks.filter((task) => object(task) && task.type === 'test').length,
      names.length,
    )
    assert.equal(result.fileComplete, true)
    if (!flushMode) {
      const final = await state()
      trace.push({ finalClocks: final?.clocks, finalHooks: final?.hooks })
      assert(Array.isArray(final?.clocks))
      assert.equal(
        final.clocks.filter((item: unknown) => object(item) && item.kind === 'body').length,
        38,
      )
      assert(
        final.clocks.every(
          (item: unknown) =>
            object(item) &&
            item.taskTimeout === 15000 &&
            item.hookTimeout === 30000 &&
            typeof item.elapsed === 'number' &&
            item.elapsed >= 0,
        ),
      )
    }
  } finally {
    clearTimeout(watchdog)
    for (const gate of releases.values()) gate.resolve()
    await joinFrameworkExecution(async () => {
      await context?.close()
    }, running)
    await browserContext?.unrouteAll({ behavior: 'wait' })
    await browser.close()
    fake.closeAllConnections()
    if (fake.listening)
      await new Promise<void>((resolve, reject) =>
        fake.close((error) => (error ? reject(error) : resolve())),
      )
    await writeFile(
      `${output}/installed-trace.json`,
      JSON.stringify({ trace, nativeCredit: false, originalCredit: false }, null, 2),
    )
  }
})

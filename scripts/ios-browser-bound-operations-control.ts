import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page, type Frame } from 'playwright'
import {
  createVitest,
  type BrowserCommand,
  type BrowserCommandContext,
  type TestProject,
} from 'vitest/node'
import type { ViteUserConfig } from 'vitest/config'
import { webdriverio } from '@vitest/browser-webdriverio'
import 'webdriverio'
import {
  createFrameworkControl,
  type FrameworkHost,
  type FrameworkResult,
} from 'waffle/testing/page-runner/framework'
import { AttachedGhosttyProvider, ghosttyFrameworkPlugin } from './ios-browser.ts'
import { frameworkEndReporter } from './ios-browser-report.ts'
import { runFrameworkNode } from './ios-browser-node.ts'
import { combinedControlModes } from './ios-browser-bound-operations-modes.ts'
import { PNG } from 'pngjs'
import {
  enclosingDeviceCapture,
  type CaptureEvidence,
  type EnclosingOptions,
} from './ios-browser-capture.ts'

const mode = process.argv[2] ?? 'pass'
assert(combinedControlModes.includes(mode), 'Unknown synthetic control mode')
const report = process.env.GHOSTTY_BOUND_REPORT ?? ''
assert(report, 'GHOSTTY_BOUND_REPORT must name the retained evidence directory')
const root = fileURLToPath(new URL('../', import.meta.url))
const file = join(root, 'scripts/fixtures/ios-browser/bound-operations.browser.test.ts')
// SYNTHETIC TRANSPORT bytes. These are not DOM pixels or crop/DPR evidence.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
  'base64',
)
const requests: string[] = []
const results: { path: string; buffer: Buffer }[] = []
const sdkBuffers: Buffer[] = []
const captureEvidence: CaptureEvidence[] = []
const captureScripts: string[] = []
let captureLookups = 0
let deniedBeforeMkdir = false
let browser: Browser | undefined
let page: Page | undefined
let active: Page | Frame | undefined
let provider: AttachedGhosttyProvider | undefined
let context: Awaited<ReturnType<typeof createVitest>> | undefined
let work: Promise<unknown> | undefined
let screenshotCalls = 0
let attachedLookups = 0
let settled = false
let nextRoot = false
let joined = false
let temporaryRemoved = false
let exactRejection = false
let officialConfigurationReads = 0
let currentCommand: BrowserCommandContext | undefined
let postClosureScreenshot: (() => Promise<unknown>) | undefined
let noPostClosureWork = false
let interruptCleanupFailed = false
const originalScratchRoot = process.env.STORAGE_SCRATCH_ROOT
let host: FrameworkHost | undefined
const hostile = {
  get message(): never {
    throw new Error('Hostile rejection inspected')
  },
  toString(): never {
    throw new Error('Hostile rejection coerced')
  },
}
const rejectionValues: Record<string, unknown> = {
  undefined,
  null: null,
  false: false,
  zero: 0,
  empty: '',
  hostile,
}
const rejection = rejectionValues[mode.replace(/^(enclosing-)?rejection-/, '')]
let scratch: string | undefined
const captureEntered = Promise.withResolvers<void>()
const captureRelease = Promise.withResolvers<void>()
const queueEntered = Promise.withResolvers<void>()
const queueRelease = Promise.withResolvers<void>()
const elements = new Map<string, string>([['retained-frame', 'iframe[data-vitest]']])
const caps = {
  browserName: 'Safari',
  browserVersion: 'SYNTHETIC HTTP DOM, NOT SAFARI',
  platformName: 'iOS',
  'safari:useSimulator': true,
  'safari:deviceUDID': 'bound-control',
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
async function body(request: IncomingMessage): Promise<unknown> {
  let text = ''
  for await (const chunk of request) text += String(chunk)
  return text ? JSON.parse(text) : null
}
type ScriptInput = { source: string; args: unknown[]; entries: [string, string][] }

function evaluateScript({ source, args, entries }: ScriptInput): unknown {
  const selectors = new Map(entries)
  const values = args.map((argument) => {
    if (
      typeof argument !== 'object' ||
      argument === null ||
      !('element-6066-11e4-a52e-4f735466cecf' in argument)
    )
      return argument
    const id = argument['element-6066-11e4-a52e-4f735466cecf']
    if (typeof id !== 'string') throw new Error('Malformed synthetic element argument')
    const selector = selectors.get(id)
    if (!selector) throw new Error('Unmapped synthetic element argument')
    return document.querySelector(selector)
  })
  const value: unknown = new Function(source).apply(window, values)
  if (typeof value !== 'object' || value === null || !('frame' in value)) return value
  if (!(value.frame instanceof HTMLIFrameElement)) return value
  return { ...value, frame: { 'element-6066-11e4-a52e-4f735466cecf': 'retained-frame' } }
}

async function execute(input: unknown): Promise<unknown> {
  assert(record(input) && typeof input.script === 'string')
  if (input.script.includes('function prepareCapture(')) captureScripts.push('prepare')
  if (input.script.includes('function measureCapture(')) captureScripts.push('measure')
  if (currentCommand && mode.endsWith('wrong-frame')) active = page
  assert(active)
  const args: unknown[] = Array.isArray(input.args) ? input.args : []
  return active.evaluate(evaluateScript, {
    source: input.script,
    args,
    entries: Array.from(elements),
  })
}
async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = request.url ?? '/'
  const input = await body(request)
  requests.push(`${request.method} ${path}`)
  let value: unknown = null
  if (request.method === 'DELETE') await browser?.close()
  if (path === '/session') value = { sessionId: 'bound-native-session', capabilities: caps }
  if (path.endsWith('/context')) {
    response.statusCode = 405
    value = { error: 'unknown command', message: 'Synthetic classic transport', stacktrace: '' }
  }
  if (path.endsWith('/url') && request.method === 'POST') {
    assert(record(input) && typeof input.url === 'string' && page)
    await page.goto(input.url)
  }
  if (path.endsWith('/window'))
    value =
      mode.endsWith('wrong-window') && currentCommand ? 'replacement-window' : 'actual-owned-window'
  if (path.endsWith('/window/handles')) value = ['actual-owned-window']
  if (path.endsWith('/execute/sync')) value = await execute(input)
  if (path.endsWith('/element') || path.endsWith('/elements')) {
    attachedLookups++
    if (record(input) && input.value === 'body') captureLookups++
    assert(record(input) && typeof input.value === 'string')
    const id = input.value === 'iframe[data-vitest]' ? 'retained-frame' : 'capture-target'
    elements.set(id, input.value)
    const element = { 'element-6066-11e4-a52e-4f735466cecf': id }
    value = path.endsWith('/elements') ? [element] : element
  }
  if (path.endsWith('/frame')) {
    assert(record(input) && page)
    active = input.id === null ? page : page.frames().find((frame) => frame !== page?.mainFrame())
    assert(active)
  }
  if (path.endsWith('/name')) value = path.includes('retained-frame') ? 'iframe' : 'body'
  if (path.endsWith('/screenshot')) {
    screenshotCalls++
    captureEntered.resolve()
    await captureRelease.promise
    value = mode.startsWith('enclosing')
      ? (await page!.screenshot({ scale: 'device' })).toString('base64')
      : png.toString('base64')
  }
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify({ value }))
}
const fake = createServer((request, response) => {
  void respond(request, response).catch(() => {
    response.statusCode = 500
    response.end(
      JSON.stringify({ value: { error: 'unknown error', message: 'Synthetic transport failure' } }),
    )
  })
})

function replaceField<T, K extends keyof T>(owner: T, key: K, value: T[K]): () => void {
  const prior = owner[key]
  owner[key] = value
  return () => {
    owner[key] = prior
  }
}

function mutate(command: BrowserCommandContext): () => void {
  const kind = mode.replace(/^(queued|settled)-/, '')
  if (kind === 'project') return replaceField(command, 'project', new Proxy(command.project, {}))
  if (kind === 'provider') return replaceField(command, 'provider', new Proxy(command.provider, {}))
  if (kind === 'browser') return replaceField(command, 'browser', new Proxy(command.browser, {}))
  if (kind === 'framework') return replaceField(command, 'sessionId', 'stale-framework')
  if (kind === 'native') return replaceField(command.browser, 'sessionId', 'stale-native')
  if (kind === 'file') return replaceField(command, 'testPath', 'wrong-file.ts')
  if (kind === 'native-options') return replaceField(command.browser.options, 'port', 1)
  if (kind === 'native-retry')
    return replaceField(command.browser.options, 'connectionRetryCount', 1)
  if (kind === 'project-browser') return replaceField(command.project, 'browser', undefined)
  if (kind === 'provider-browser') {
    assert(provider?.browser)
    return replaceField(provider, 'browser', new Proxy(provider.browser, {}))
  }
  if (kind === 'project-provider') {
    assert(command.project.browser)
    return replaceField(command.project.browser, 'provider', new Proxy(command.provider, {}))
  }
  if (kind === 'native-capabilities')
    return replaceField(command.browser.capabilities, 'platformName', 'changed-platform')
  throw new Error(`Unknown mutation ${mode}`)
}

function installBufferObserver(actual: NonNullable<AttachedGhosttyProvider['browser']>): void {
  if (mode.startsWith('enclosing')) {
    actual.overwriteCommand('saveScreenshot', async function (original, path) {
      const buffer = await original(path)
      sdkBuffers.push(buffer)
      return buffer
    })
    return
  }
  actual.overwriteCommand(
    'saveScreenshot',
    async function (original, path: string) {
      const buffer = await original(path)
      sdkBuffers.push(buffer)
      if (mode.startsWith('rejection-')) {
        assert(currentCommand)
        currentCommand.testPath = 'changed-during-official-rejection.ts'
        throw rejection
      }
      return buffer
    },
    true,
  )
}

async function mutateDOM(): Promise<void> {
  assert(page)
  if (
    mode.endsWith('replaced') ||
    mode.endsWith('transient-frame') ||
    mode.endsWith('transient-ancestor')
  ) {
    const tester = page.frames().find((frame) => frame !== page?.mainFrame())
    assert(tester)
    await page.route(tester.url(), (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Synthetic replacement at the same URL</title>',
      }),
    )
  }
  await page.evaluate((mode) => {
    const frame = document.querySelector('iframe[data-vitest]')
    if (!(frame instanceof HTMLIFrameElement) || !frame.contentWindow)
      throw new Error('Missing admitted tester')
    if (mode.endsWith('closed')) {
      const observation = Reflect.get(
        frame.contentWindow,
        Symbol.for('waffle.framework.observation'),
      )()
      observation.executionFlushed()
    }
    if (mode.endsWith('replaced')) frame.replaceWith(frame.cloneNode())
    if (mode.endsWith('wrong-document'))
      frame.contentDocument?.open().write('<!doctype html><title>Replacement document</title>')
    if (mode.endsWith('transient-frame')) {
      frame.remove()
      document.body.append(frame)
    }
    const ancestor = frame.parentElement
    if (!ancestor) throw new Error('Missing retained ancestor')
    if (mode.endsWith('transient-ancestor')) {
      ancestor.remove()
      document.documentElement.append(ancestor)
    }
    if (mode.endsWith('retiring')) {
      const observation = Reflect.get(
        frame.contentWindow,
        Symbol.for('waffle.framework.observation'),
      )()
      observation.testerCleanupSettled()
    }
    if (mode.endsWith('top-pagehide')) dispatchEvent(new PageTransitionEvent('pagehide'))
    if (mode.endsWith('tester-pagehide'))
      frame.contentWindow?.dispatchEvent(new PageTransitionEvent('pagehide'))
  }, mode)
}

async function changeContext(command: BrowserCommandContext): Promise<() => void> {
  if (/closed|replaced|retiring|pagehide|wrong-document|transient/.test(mode)) {
    await mutateDOM()
    return () => {}
  }
  if (/wrong-frame|wrong-window/.test(mode)) return () => {}
  return mutate(command)
}

function rejectOfficialConfiguration(command: BrowserCommandContext): () => void {
  const project = command.project
  const prior = Object.getOwnPropertyDescriptor(project, 'config')
  const restore = () => {
    if (prior) Object.defineProperty(project, 'config', prior)
    else Reflect.deleteProperty(project, 'config')
  }
  Object.defineProperty(project, 'config', {
    configurable: true,
    get() {
      officialConfigurationReads++
      restore()
      command.testPath = 'changed-during-official-rejection.ts'
      throw rejection
    },
  })
  return restore
}

async function invokeScreenshot<T>(
  command: BrowserCommandContext,
  invoke: () => Promise<T>,
): Promise<T> {
  assert(host && provider?.browser)
  currentCommand = command
  postClosureScreenshot = invoke
  installBufferObserver(provider.browser)
  if (mode === 'enclosing') await rejectedCapturePreconditions(command.browser)
  let undo = () => {}
  let blocked: Promise<void> | undefined
  if (mode.startsWith('queued-')) {
    blocked = host.provider('framework-cleanup', async () => {
      queueEntered.resolve()
      await queueRelease.promise
    })
    await queueEntered.promise
  }
  const configurationFailure = mode.includes('rejection-') && mode !== 'rejection-hostile'
  if (configurationFailure) undo = rejectOfficialConfiguration(command)
  const pending = invoke()
  void pending.catch(() => {})
  void pending.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  if (mode.startsWith('queued-')) {
    undo = await changeContext(command)
    queueRelease.resolve()
    await blocked
    captureRelease.resolve()
  }
  if (!mode.startsWith('queued-') && !configurationFailure) {
    await Promise.race([
      captureEntered.promise,
      pending.then(() => {
        throw new Error('Screenshot settled before capture')
      }),
    ])
    assert.equal(settled, false, 'Official callback must still own pending HTTP')
    const next = host.provider('framework-cleanup', async () => {
      assert.equal(sdkBuffers.length, 1, 'Later root began before the official SDK save settled')
      nextRoot = true
    })
    void next.catch(() => {})
    assert.equal(nextRoot, false)
    if (mode.startsWith('settled-')) undo = await changeContext(command)
    if (mode === 'enclosing-geometry-change') {
      assert(active)
      await active.evaluate(() => {
        document.querySelector<HTMLElement>('#synthetic-transport-target')!.style.left = '11.5px'
      })
    }
    captureRelease.resolve()
    void next.then(
      () => {
        joined = true
      },
      () => {},
    )
  }
  try {
    return await pending
  } catch (reason) {
    if (mode === 'enclosing-geometry-change') {
      assert.match(String(reason), /geometry changed/)
      assert.deepEqual(await readdir(command.project.tmpDir), [])
      temporaryRemoved = true
    }
    if (!mode.includes('rejection-')) throw reason
    assert.equal(
      reason,
      rejection,
      'Official rejection identity must win over the context post-check',
    )
    assert.equal(provider.secondaryContextFaults.length, 1)
    exactRejection = true
    throw new Error('EXPECTED_OFFICIAL_REJECTION')
  } finally {
    undo()
  }
}

async function rejectedCapturePreconditions(browser: WebdriverIO.Browser): Promise<void> {
  const before = requests.length
  const options: EnclosingOptions = {
    element: { selector: '#synthetic-transport-target', locator: null },
    scale: 'device',
    save: false,
  }
  const official = async (): Promise<never> => {
    throw new Error('Precondition called official callback')
  }
  await assert.rejects(
    () => enclosingDeviceCapture(official, { browser, testerSelected: false, options }),
    /selected tester in classic/,
  )
  const bidi = new Proxy(browser, {
    get(target, key, receiver) {
      return key === 'isBidi' || Reflect.get(target, key, receiver)
    },
  })
  await assert.rejects(
    () => enclosingDeviceCapture(official, { browser: bidi, testerSelected: true, options }),
    /selected tester in classic/,
  )
  assert.equal(requests.length, before, 'Preconditions must issue no WebDriver requests')
}

async function recordResult(value: unknown, command: BrowserCommandContext): Promise<void> {
  assert(record(value) && typeof value.path === 'string' && Buffer.isBuffer(value.buffer))
  if (mode === 'enclosing') {
    assert(provider?.isIframeSwitched())
    const image = PNG.sync.read(value.buffer)
    assert.deepEqual([image.width, image.height], [43, 27])
    assert.deepEqual(
      Array.from(image.data.subarray((13 * 43 + 21) * 4, (13 * 43 + 21) * 4 + 4)),
      [49, 90, 155, 255],
    )
  } else
    assert.equal(
      value.buffer,
      sdkBuffers.at(-1),
      'Exact SDK Buffer must survive unchanged official route',
    )
  if (mode === 'temporary' || mode === 'enclosing') {
    assert.deepEqual(await readdir(command.project.tmpDir), [])
    temporaryRemoved = true
  }
  results.push({ path: value.path, buffer: value.buffer })
}

function observedScreenshot<Payload extends unknown[], Result>(
  command: BrowserCommand<Payload, Result>,
): BrowserCommand<Payload, Result> {
  return async function (this: unknown, commandContext, ...payload) {
    const invoke = async () => command.call(this, commandContext, ...payload)
    const value = await invokeScreenshot(commandContext, invoke)
    await recordResult(value, commandContext)
    return value
  }
}

function makeProvider(project: TestProject): AttachedGhosttyProvider {
  assert(host)
  const server = project.browser
  assert(server)
  const original = server.registerCommand
  const forward: typeof original = original.bind(server)
  const register: typeof original = function (name, command) {
    if (name !== '__vitest_takeScreenshot') return forward(name, command)
    forward(name, observedScreenshot(command))
  }
  server.registerCommand = register
  try {
    provider = new AttachedGhosttyProvider(project, host, (_name, evidence) => {
      captureEvidence.push(evidence)
    })
  } finally {
    server.registerCommand = original
  }
  return provider
}

async function closeContext(): Promise<void> {
  captureRelease.resolve()
  queueRelease.resolve()
  await browser?.close()
  await context?.close()
}

async function executeFramework(registerClose: (close: () => Promise<void>) => void) {
  assert(host && scratch)
  registerClose(closeContext)
  const normal = frameworkEndReporter()
  const configuration = {
    define: {
      BOUND_CONTROL_MODE: JSON.stringify(mode),
      BOUND_CONTROL_PATH: JSON.stringify(join(scratch, 'capture/synthetic-transport.png')),
    },
    cacheDir: join(scratch, 'vite'),
    plugins: [ghosttyFrameworkPlugin(host)],
    server: {
      fs: { allow: [root, scratch, fileURLToPath(new URL('../node_modules', import.meta.url))] },
    },
    test: {
      include: [file],
      testTimeout: 15000,
      hookTimeout: 15000,
      retry: 0,
      fileParallelism: false,
      reporters: ['default', normal.reporter],
      browser: {
        enabled: true,
        headless: false,
        ui: false,
        screenshotFailures: false,
        viewport: { width: 414, height: 896 },
        provider: { ...webdriverio(), providerFactory: makeProvider },
        instances: [{ browser: 'safari' }],
        commands: {},
      },
    },
  } satisfies ViteUserConfig
  context = await createVitest('test', { root, config: false, watch: false }, configuration)
  work = context.start([file])
  await work
  return normal.endStatus()
}

async function verifyResult(result: FrameworkResult): Promise<void> {
  const closedProvider = provider
  assert(closedProvider && postClosureScreenshot)
  const before = requests.length
  await assert.rejects(postClosureScreenshot)
  await assert.rejects(() => closedProvider.openBrowser())
  await assert.rejects(() => closedProvider.setViewport({ width: 800, height: 600 }))
  assert.equal(requests.length, before, 'No SDK work may start after closure')
  noPostClosureWork = true
  assert.equal(requests.filter((path) => path === 'DELETE /session/bound-native-session').length, 1)
  assert.equal(result.cleanup.scratch.status, 'confirmed')
  assert.equal(interruptCleanupFailed, false)
  assert.equal(result.rootBrowserSuiteComplete, false)
  assert.equal(
    requests.some((path) => /window\/rect|actions|cdp/.test(path)),
    false,
  )
  assert(result.binding, 'The same combined fixture must admit actual paired documents')
  assert(result.documents.every((document) => document.doc !== null))
  const viewportCaptures = requests.filter(
    (path) => path === 'GET /session/bound-native-session/screenshot',
  )
  const elementCaptures = requests.filter((path) =>
    /GET .*\/element\/[^/]+\/screenshot$/.test(path),
  )
  if (mode.startsWith('enclosing')) {
    assert.equal(
      viewportCaptures.length,
      mode === 'enclosing-rejection-null' ? 0 : 1,
      JSON.stringify(result.failures),
    )
    assert.equal(elementCaptures.length, 0)
    if (mode !== 'enclosing-rejection-null') assert.equal(temporaryRemoved, true)
  }
  if (mode !== 'pass' && mode !== 'temporary' && mode !== 'enclosing') {
    assert.equal(result.exit, 2)
    if (mode.includes('rejection-')) assert.equal(exactRejection, true)
    if (mode.includes('rejection-') && mode !== 'rejection-hostile')
      assert.equal(officialConfigurationReads, 1)
    if (mode.startsWith('queued-')) {
      assert.equal(screenshotCalls, 0)
      assert.equal(captureLookups, 0)
      assert(scratch)
      const directories = await readdir(scratch)
      assert.equal(
        directories.includes('capture'),
        false,
        'Denied callback created its screenshot directory',
      )
      deniedBeforeMkdir = true
    }
    return
  }
  assert.equal(result.exit, 4, JSON.stringify(result.failures))
  assert.equal(result.fileComplete, true)
  assert.equal(result.framework?.status, 'passed')
  assert.equal(screenshotCalls, 1)
  assert.equal(results.length, 1)
  assert.equal(joined, true)
  const actual = results[0]
  assert(actual)
  if (mode === 'enclosing') {
    assert.deepEqual(captureScripts, ['prepare', 'measure', 'measure'])
    assert.equal(captureEvidence.length, 1)
    assert.deepEqual(captureEvidence[0]?.before, captureEvidence[0]?.after)
    assert.deepEqual(captureEvidence[0]?.png, { width: 43, height: 27, profiles: [] })
    return
  }
  assert.equal(viewportCaptures.length, 0)
  assert.equal(elementCaptures.length, 1)
  assert.deepEqual(actual.buffer, png)
  if (mode === 'pass') assert.deepEqual(await readFile(actual.path), png)
  if (mode === 'temporary') assert.equal(temporaryRemoved, true)
}

function interrupted(): void {
  void closeContext().catch(() => {
    interruptCleanupFailed = true
  })
}

async function stopServer(): Promise<void> {
  fake.closeAllConnections()
  if (!fake.listening) return
  await new Promise<void>((resolve) => fake.close(() => resolve()))
}

async function run(): Promise<void> {
  process.once('SIGTERM', interrupted)
  try {
    scratch = await mkdtemp(join(process.env.GHOSTTY_BOUND_SCRATCH ?? tmpdir(), 'gb-'))
    process.env.STORAGE_SCRATCH_ROOT = scratch
    browser = await chromium.launch({ headless: true, env: { ...process.env, TMPDIR: scratch } })
    page = await browser.newPage({ viewport: { width: 700, height: 1000 } })
    active = page
    fake.listen(0, '127.0.0.1')
    await once(fake, 'listening')
    const address = fake.address()
    assert(address && typeof address !== 'string')
    host = createFrameworkControl(
      {
        suite: `ghostty-bound-${mode}`,
        native: { udid: 'bound-control' },
        expected: [
          {
            file,
            fullName: 'combined synthetic transport operation',
            sourceKey: 'synthetic:1',
            timeoutMs: 15000,
            retries: 0,
          },
        ],
        scope: { kind: 'root-selection', command: 'test:browser', files: [file] },
        resultPath: join(report ?? '', `${mode}-host.json`),
      },
      `http://127.0.0.1:${address.port}/`,
    )
    const result = await host.run(executeFramework)
    await verifyResult(result)
    await writeFile(
      join(report, `${mode}.json`),
      JSON.stringify(
        {
          result,
          requests,
          screenshotCalls,
          attachedLookups,
          captureLookups,
          deniedBeforeMkdir,
          joined,
          temporaryRemoved,
          exactRejection,
          officialConfigurationReads,
          noPostClosureWork,
          captureEvidence,
          captureScripts,
          results: results.map((item) => ({ path: item.path, bytes: item.buffer.length })),
          syntheticTransport: true,
          nativeCredit: false,
        },
        null,
        2,
      ),
    )
    process.exitCode = 0
  } finally {
    process.off('SIGTERM', interrupted)
    if (originalScratchRoot === undefined) delete process.env.STORAGE_SCRATCH_ROOT
    else process.env.STORAGE_SCRATCH_ROOT = originalScratchRoot
    captureRelease.resolve()
    queueRelease.resolve()
    await browser?.close()
    await context?.close()
    await work?.catch(() => {})
    await stopServer()
    if (scratch) await rm(scratch, { recursive: true, force: true })
  }
}

await runFrameworkNode(run)

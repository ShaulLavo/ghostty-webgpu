import { getGlobalDispatcher } from 'undici'
import { OwnedFrameworkDispatcher } from '../../../scripts/ios-browser-node.ts'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createVitest } from 'vitest/node'
import type { ViteUserConfig } from 'vitest/config'
import type { ViteDevServer } from 'vite'
import { webdriverio, WebdriverBrowserProvider } from '@vitest/browser-webdriverio'
import { AttachedGhosttyProvider, ghosttyFrameworkPlugin } from '../../../scripts/ios-browser.ts'
import { frameworkEndReporter } from '../../../scripts/ios-browser-report.ts'
import { websocketControl } from './websocket-control.ts'
import { createBrowserTestConfig } from '../../../vitest.browser.config.ts'
import { createFrameworkControl, type FrameworkHost } from 'waffle/testing/page-runner/framework'

function settleLater<T>(promise: Promise<T>, settled: () => void): void {
  void promise.then(settled, settled)
}
type AttachedBrowser = NonNullable<AttachedGhosttyProvider['browser']>

async function rejectExpiredRequest(host: FrameworkHost, browser: AttachedBrowser): Promise<void> {
  const later = Promise.withResolvers<void>()
  await host.provider('framework-cleanup', async () => {
    setTimeout(() => settleLater(browser.getTitle(), later.resolve), 15)
  })
  await later.promise
}

async function checkForbiddenRequest(
  host: FrameworkHost,
  provider: AttachedGhosttyProvider,
  browser: AttachedBrowser,
  before: number,
): Promise<void> {
  if (mode === 'malformed') {
    malformed = true
    await host.provider('framework-cleanup', async () => {
      await browser.execute(() => true).catch(() => {})
    })
    return
  }
  if (mode === 'expired') {
    await rejectExpiredRequest(host, browser)
    assert.equal(requests.length, before)
    return
  }
  if (mode === 'revoked') await provider.close()
  await browser.getTitle().catch(() => {})
  assert.equal(requests.length, before)
}

assert(
  getGlobalDispatcher() instanceof OwnedFrameworkDispatcher,
  'Dispatcher must survive SDK module initialization before host work',
)
const directory = process.cwd()
const report = process.env.GHOSTTY_FRAMEWORK_REPORT
assert.ok(report)
const mode = process.env.GHOSTTY_FRAMEWORK_MODE ?? 'unowned'
if (mode !== 'unowned' && mode !== 'malformed' && mode !== 'expired' && mode !== 'revoked')
  throw new Error(`Unsupported local SDK control mode: ${mode}`)
const requests: { method: string; path: string; body: unknown }[] = []
const element = { 'element-6066-11e4-a52e-4f735466cecf': 'actual-frame' }
const caps = {
  browserName: 'Safari',
  browserVersion: '26.5',
  platformName: 'iOS',
  'safari:useSimulator': true,
  'safari:deviceUDID': 'control-device',
  extraActual: 'retained',
}
let malformed = false
let releaseLookup: (() => void) | undefined
let lookupHeld = false
let navigation: string | undefined
async function answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString()
  const body: unknown = text ? JSON.parse(text) : null
  const path = request.url ?? '/'
  requests.push({ method: request.method ?? '', path, body })
  if (path.endsWith('/element') && lookupHeld)
    await new Promise<void>((resolve) => {
      releaseLookup = resolve
    })
  if (path.endsWith('/execute/sync') && malformed) {
    response.end('{broken')
    return
  }
  if (
    path.endsWith('/url') &&
    request.method === 'POST' &&
    typeof body === 'object' &&
    body !== null &&
    'url' in body
  )
    navigation = String(body.url)
  let value: unknown = null
  if (path === '/session') value = { sessionId: 'owned-session', capabilities: caps }
  if (path.endsWith('/context')) {
    response.statusCode = 405
    value = {
      error: 'unknown command',
      message: 'CONTROL ONLY: tolerated context request',
      stacktrace: '',
    }
  }
  if (path.endsWith('/window')) value = 'actual-window'
  if (path.endsWith('/window/handles')) value = ['actual-window']
  if (path.endsWith('/element')) value = element
  if (path.endsWith('/elements')) value = [element]
  if (path.endsWith('/element/actual-frame/name')) value = 'iframe'
  if (path.endsWith('/execute/sync')) value = null
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify({ value }))
}
const fake = createServer((request, response) => {
  void answer(request, response).catch((error) => {
    response.statusCode = 500
    response.end(String(error))
  })
})
// Teardown is installed before either owned listener is started.
let host: FrameworkHost | undefined
let provider: AttachedGhosttyProvider | undefined
const trace: string[] = []
const ordinary = frameworkEndReporter()
const navigationEnd = Promise.withResolvers<void>()
void navigationEnd.promise.catch(() => {})
const viteServers = new Set<ViteDevServer>()
let context: Awaited<ReturnType<typeof createVitest>> | undefined
const close = async () => {
  await context?.close()
  fake.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    fake.close((error) => (error ? reject(error) : resolve())),
  )
}
try {
  fake.listen(0, '127.0.0.1')
  await once(fake, 'listening')
  const address = fake.address()
  if (!address || typeof address === 'string') throw new Error('No fake listener')
  const file = join(directory, 'scripts/fixtures/ios-browser/control.browser.test.ts')

  host = createFrameworkControl(
    {
      suite: 'installed-sdk-control',
      native: { udid: 'control-device' },
      expected: [
        {
          file,
          fullName: 'not executed by the HTTP fake',
          sourceKey: 'control:1',
          timeoutMs: 15000,
          retries: 0,
        },
      ],
      scope: { kind: 'root-selection', command: 'test:browser', files: [file] },
      resultPath: join(report, 'sdk-host-result.json'),
    },
    `http://127.0.0.1:${address.port}/`,
  )
  const ownedHost = host
  class AttachedProvider extends AttachedGhosttyProvider {
    override async openPage(sessionId: string, url: string) {
      await super.openPage(sessionId, url)
      await navigationEnd.promise
    }
  }
  const stock = webdriverio({})
  const attached = {
    ...stock,
    providerFactory(project: ConstructorParameters<typeof WebdriverBrowserProvider>[0]) {
      provider = new AttachedProvider(project, ownedHost)
      return provider
    },
  }
  const result = await host.run(async (registerClose) => {
    const base = createBrowserTestConfig()
    const nativeConfig = {
      ...base,
      test: {
        ...base.test,
        reporters: ['default', ordinary.reporter],
        testTimeout: 15000,
        hookTimeout: 30000,
        retry: 0,
        include: [file],
        browser: {
          ...base.test.browser,
          provider: attached,
          commands: {},
          headless: false,
          connectTimeout: 60000,
          instances: [{ browser: 'safari' }],
        },
      },
      plugins: base.plugins.concat([
        ghosttyFrameworkPlugin(ownedHost),
        {
          name: 'owned-vite-lifetime',
          configureServer(server) {
            viteServers.add(server)
          },
        },
      ]),
    } satisfies ViteUserConfig
    context = await createVitest(
      'test',
      { root: directory, config: false, watch: false },
      nativeConfig,
    )
    registerClose(async () => {
      navigationEnd.reject(new Error('EXPECTED_FINITE_FAKE_ABORT'))
      await context?.close()
      for (const server of viteServers) assert.equal(server.httpServer?.listening, false)
      trace.push('context-closed')
    })
    const starting = context.start([file])
    void starting.catch(() => {})
    for (let attempt = 0; !navigation && attempt < 200; attempt++) await delay(10)
    assert.ok(navigation, 'normal start must call inherited openPage')
    const topHtml = await (await fetch(navigation)).text()
    assert.match(topHtml, /__waffleFrameworkConfiguration/)
    const sessionId = urlSession(navigation)
    const testerUrl = new URL('/?sessionId=' + sessionId + '&iframeId=local-control', navigation)
      .href
    const testerHtml = await (await fetch(testerUrl)).text()
    assert.match(testerHtml, /__waffleFrameworkConfiguration/)
    assert.match(testerHtml, /tester-COH68OX9.js/)
    await writeFile(join(report, 'orchestrator.html'), topHtml)
    await writeFile(join(report, 'tester.html'), testerHtml)
    const server = context.projects.find((project) => project.browser)?.browser
    assert.ok(server)
    const url = new URL(navigation)
    assert.equal(url.pathname, '/__vitest_test__/')
    const vite = await fetch(new URL('/@vite/client', navigation))
    assert.equal(vite.status, 200)
    assert.match(await vite.text(), /WebSocket/)
    const actualServer = Array.from(viteServers).find((instance) => {
      const address = instance.httpServer?.address()
      return address && typeof address === 'object' && address.port === Number(url.port)
    })
    assert.ok(actualServer)
    await websocketControl(
      new URL(actualServer.config.base, navigation),
      actualServer.config.webSocketToken,
    )
    trace.push('actual-vite-websocket-open-and-close')
    assert.equal((await fetch(new URL('/report', navigation))).status, 405)
    assert.ok(provider?.browser)
    const actualProvider = provider
    const browser = provider.browser
    assert.equal(actualProvider.name, stock.name)
    assert.equal(typeof stock.serverFactory, 'function')
    assert(actualProvider.initScripts.some((path) => path.endsWith('/locators.js')))
    assert.equal(actualProvider.supportsParallelism, false)
    const beforeUnsupported = requests.length
    await assert.rejects(actualProvider.getCDPSession(), /unsupported/)
    assert.equal(requests.length, beforeUnsupported)
    assert.equal(actualProvider.isIframeSwitched(), false)
    await ownedHost.provider('test-frame', () => actualProvider.switchToTestFrame())
    assert.equal(actualProvider.isIframeSwitched(), true)
    await ownedHost.provider('test-frame', async () => {
      const beforeNested = requests.length
      await actualProvider.switchToTestFrame()
      assert.equal(
        requests.length,
        beforeNested,
        'Nested selected tester must not be searched inside itself',
      )
    })
    await ownedHost.provider('main-frame', () => actualProvider.switchToMainFrame())
    assert.equal(actualProvider.isIframeSwitched(), false)
    lookupHeld = true
    const switching = actualProvider.switchToTestFrame()
    for (let attempt = 0; !releaseLookup && attempt < 100; attempt++) await delay(5)
    assert.ok(releaseLookup, 'Inherited lookup must be pending')
    let probed = false
    const probe = ownedHost.provider('framework-cleanup', async () => {
      probed = true
      trace.push('serialized-probe')
    })
    await delay(30)
    assert.equal(probed, false, 'Probe must not pass an inherited pending frame operation')
    lookupHeld = false
    releaseLookup()
    await switching
    await probe
    assert.equal(actualProvider.isIframeSwitched(), true)
    await actualProvider.switchToMainFrame()
    trace.push('nested-public-frame-bookkeeping')
    const beforeForbidden = requests.length
    try {
      await checkForbiddenRequest(ownedHost, actualProvider, browser, beforeForbidden)
    } finally {
      navigationEnd.reject(new Error('EXPECTED_FINITE_FAKE_ABORT'))
    }
    trace.push(`${mode}-rejection-caught`)
    await starting
    return ordinary.endStatus()
  })
  await writeFile(
    join(report, `result-${mode}.json`),
    JSON.stringify({ result, requests, trace }, null, 2),
  )
  assert.ok(
    trace.includes('nested-public-frame-bookkeeping'),
    'Every required frame proof must execute',
  )
  assert.ok(trace.includes('serialized-probe'))
  if (mode !== 'malformed') assert.ok(trace.includes(`${mode}-rejection-caught`))
  assert.equal(result.exit, 2)
  if (mode === 'malformed') assert.equal(result.framework, null)
  else assert.equal(result.framework?.status, 'failed')
  assert(
    result.documents.every(
      (document) => document.ackedThrough === null && document.pending === null,
    ),
    'No observed page ACK may be inferred from accepted reports',
  )
  assert(trace.includes('actual-vite-websocket-open-and-close'))
  assert(
    !requests.some((request) =>
      /window\/rect|screenshot|actions|keys|click|cdp/.test(request.path),
    ),
    'No unsupported native HTTP',
  )
  assert.equal(result.fileComplete, false)
  assert.equal(result.rootBrowserSuiteComplete, false)
  assert.equal(
    requests.filter((request) => request.method === 'POST' && request.path === '/session').length,
    1,
  )
  assert.equal(requests.filter((request) => request.method === 'DELETE').length, 1)
  assert.equal(result.cleanup.callbacks.status, 'confirmed')
  assert.equal(result.cleanup.scratch.status, 'confirmed')
  assert.ok(provider)
  await assert.rejects(provider.openBrowser(), /closed/)

  await writeFile(
    join(report, 'sdk-checkpoint.json'),
    JSON.stringify(
      {
        navigation,
        requests,
        trace,
        result,
        browserExecuted: false,
        nativeCredit: false,
      },
      null,
      2,
    ),
  )
  process.exitCode = 0 // The ordinary reporter correctly failed the deliberately aborted fake run.
  console.log(
    'Installed Node / real Vite / normal createVitest.start / real attached provider: finite abort and checked cleanup confirmed',
  )
} finally {
  navigationEnd.reject(new Error('EXPECTED_FINITE_FAKE_ABORT'))
  await close()
  for (const server of viteServers) {
    assert.equal(server.httpServer?.listening, false)
    assert.equal(server.ws.clients.size, 0)
  }
  assert.equal(fake.listening, false)
  await writeFile(
    join(report, `actual-join-${mode}.json`),
    JSON.stringify(
      {
        contextHttpClosed: true,
        contextWebSocketsClosed: true,
        fakeHttpClosed: true,
        parentDeletes: requests.filter((request) => request.method === 'DELETE').length,
      },
      null,
      2,
    ),
  )
}

function urlSession(url: string): string {
  const id = new URL(url).searchParams.get('sessionId')
  assert.ok(id)
  return id
}

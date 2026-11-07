import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createVitest, type Reporter } from 'vitest/node'
import { playwright } from '@vitest/browser-playwright'
import { createBrowserTestConfig } from '../../../vitest.browser.config.ts'
import { frameworkEndReporter } from '../../../scripts/ios-browser-report.ts'
import { ghosttyFrameworkPlugin, rejectNativeBrowserCommand } from '../../../scripts/ios-browser.ts'
import type { ViteDevServer } from 'vite'
import type { Json } from 'waffle/testing/page-runner/framework'

const report = process.env.GHOSTTY_FRAMEWORK_REPORT
assert.ok(report)
const mode = process.env.GHOSTTY_FRAMEWORK_MODE ?? 'clean'
const events: { event: string; role: string; detail?: Json; sequence?: number }[] = []
const source = await readFile(process.env.GHOSTTY_FRAMEWORK_OBSERVER ?? '', 'utf8')
const emissions: { kind: string; url: string; html: string }[] = []
let context: Awaited<ReturnType<typeof createVitest>> | undefined
let ended = false
const localServers = new Set<ViteDevServer>()
const normal: string[] = []
const reporter: Reporter = {
  onTestModuleCollected: () => {
    normal.push('ordinary-collected')
  },
  onTestRunEnd: (_modules, errors, reason) => {
    normal.push(`ordinary-end:${reason}:errors:${errors.length}`)
    ended = true
  },
}
async function recordLocalEvent(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString())
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('event' in parsed) ||
    typeof parsed.event !== 'string' ||
    !('role' in parsed) ||
    typeof parsed.role !== 'string'
  )
    throw new Error('Invalid local event')
  const event = parsed.event
  const role = parsed.role
  const detail: unknown = 'detail' in parsed ? parsed.detail : null
  const sequence =
    'sequence' in parsed && typeof parsed.sequence === 'number' ? parsed.sequence : undefined
  events.push({ event, role, sequence })
  await writeFile(`${report}/${mode}-${events.length}.event.json`, JSON.stringify(parsed))
  if (event === 'collected') {
    if (mode === 'inventory-reject') throw new Error('LOCAL_INVENTORY_REJECT')
    assert(normal.includes('ordinary-collected'), 'Original collection RPC precedes observer ACK')
    await new Promise((resolve) => setTimeout(resolve, 60))
    events.push({ event: 'inventory-ack', role })
  }
  if (event === 'startup-wait') await new Promise((resolve) => setTimeout(resolve, 80))
  if (event === 'local-retirement-gate') {
    assert.equal(ended, false, 'Retirement must precede ordinary end reporter')
    assert.deepEqual(detail, { testerConnected: true })
  }
  response.end('LOCAL_DOUBLE_ACK')
}

const localObservationSink: import('waffle/testing/page-runner/framework').FrameworkHost['middleware'] =
  (request, response, next) => {
    if (request.url !== '/ghostty-local-event') {
      next()
      return
    }
    void recordLocalEvent(request, response).catch((error) => {
      response.statusCode = 500
      response.end(String(error))
    })
  }

async function checkLocalSink(): Promise<void> {
  const server = Array.from(localServers).find((instance) => instance.httpServer?.listening)
  const address = server?.httpServer?.address()
  assert(address && typeof address === 'object')
  const before = events.length
  for (const payload of [
    { event: ['collected'], role: 'tester' },
    { event: 'collected', role: ['tester'] },
    { event: 1, role: 'tester' },
  ]) {
    const response: Response = await fetch(`http://127.0.0.1:${address.port}/ghostty-local-event`, {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    assert.equal(response.status, 500)
    assert.match(await response.text(), /Invalid local event/)
  }
  assert.equal(events.length, before, 'Malformed discriminants must not enter the event list')
  await writeFile(
    `${report}/sink-string-guards.json`,
    JSON.stringify({ rejectedArraysAndNumber: true, acceptedMalformedEvents: 0 }, null, 2),
  )
}

const base = createBrowserTestConfig()
const ordinary = frameworkEndReporter()
assert.throws(ordinary.endStatus, /No ordinary/)
const desktopProvider = playwright({
  launchOptions: {
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  },
})
const policyProvider = {
  ...desktopProvider,
  providerFactory(project: Parameters<typeof desktopProvider.providerFactory>[0]) {
    const provider = desktopProvider.providerFactory(project)
    if (mode !== 'viewport-reject') return provider
    const browser = project.browser
    assert.ok(browser)
    browser.registerCommand('__vitest_viewport', (_context, payload: unknown) => {
      assert.deepEqual(payload, { width: 414, height: 896 })
      events.push({ role: 'node', event: 'rejected-explicit-viewport-rpc' })
      return rejectNativeBrowserCommand('__vitest_viewport')
    })
    return provider
  },
}
let injected = 0
try {
  context = await createVitest(
    'test',
    { config: false, watch: false },
    {
      ...base,
      plugins: base.plugins.concat([
        {
          name: 'local-sink-context',
          configureServer(server) {
            localServers.add(server)
          },
        },
        {
          name: 'ghostty-local-prepare-fault',
          enforce: 'pre',
          transform(code, id) {
            if (mode !== 'caught-observer-throws' || !id.includes('tester-COH68OX9.js')) return
            const anchor =
              'await prepare(data).catch((err) => unhandledError(err, "Prepare Error"))'
            assert.equal(code.split(anchor).length, 2)
            injected++
            return code.replace(
              anchor,
              'await prepare(data).then(() => { throw new Error("GHOSTTY_CONTROL_CAUGHT_PREPARE") }).catch((err) => unhandledError(err, "Prepare Error"))',
            )
          },
        },
        ghosttyFrameworkPlugin({
          mount(stack) {
            stack.use(localObservationSink)
          },
          instrumentDocument(input) {
            emissions.push(input)
            const throws = mode === 'observer-throws' || mode === 'caught-observer-throws'
            const code = `Reflect.set(globalThis, Symbol.for('ghostty.local.observerThrows'), ${throws});\n${source}`
            return input.html.replace(
              '<head>',
              `<head><script>${code.replaceAll('</script', '<\\/script')}</script>`,
            )
          },
        }),
      ]),
      test: {
        ...base.test,
        include: ['scripts/fixtures/ios-browser/lifecycle.browser.test.ts'],
        env: { GHOSTTY_FRAMEWORK_MODE: mode },
        testTimeout: 15000,
        hookTimeout: 30000,
        retry: 0,
        reporters: ['default', reporter, ordinary.reporter],
        browser: {
          ...base.test.browser,
          headless: true,
          provider: policyProvider,
          instances: [{ browser: 'chromium' }],
          commands: {
            __ghostty_initialViewport: async (_context, request: unknown) => {
              assert.deepEqual(request, {
                permit: 'LOCAL_DESKTOP_DOUBLE_ONLY',
                width: 414,
                height: 896,
              })
              events.push({ role: 'node', event: 'dedicated-initial-viewport' })
            },
          },
        },
      },
    },
  )
  await context.start(['scripts/fixtures/ios-browser/lifecycle.browser.test.ts'])
  if (mode === 'clean') await checkLocalSink()
  assert.equal(ended, true)
  assert.deepEqual(emissions.map((item) => item.kind).sort(), ['orchestrator', 'tester'])
  const names = events.map((item) => item.event)
  assert(names.indexOf('startup-wait') < names.indexOf('dedicated-initial-viewport'))
  assert(names.indexOf('dedicated-initial-viewport') < names.indexOf('collected'))
  if (mode !== 'inventory-reject' && mode !== 'import-fault')
    assert(names.indexOf('inventory-ack') < names.indexOf('before-all'))
  if (mode === 'inventory-reject' || mode === 'import-fault') assert(!names.includes('before-all'))
  const flushed = events.find(
    (event) => event.role === 'tester' && event.event === 'execution-flushed',
  )?.sequence
  const cleaned = events.find(
    (event) => event.role === 'tester' && event.event === 'tester-cleanup-settled',
  )?.sequence
  assert(flushed !== undefined && cleaned !== undefined && flushed < cleaned)
  assert(names.indexOf('tester-cleanup-settled') < names.indexOf('local-retirement-gate'))
  assert(names.indexOf('cleanup-response-received') < names.indexOf('local-retirement-gate'))
  assert(names.includes('local-retirement-gate'))
  if (mode !== 'before-all' && mode !== 'inventory-reject' && mode !== 'import-fault')
    assert(names.indexOf('after-each') < names.indexOf('case-settled'))
  if (
    mode === 'late-error' ||
    mode === 'observer-throws' ||
    mode === 'inventory-reject' ||
    mode === 'caught-observer-throws' ||
    mode === 'viewport-reject'
  )
    assert(names.includes('error'))
  if (mode === 'fixture-error')
    assert(names.indexOf('fixture-cleanup') < names.indexOf('case-settled'))
  if (mode === 'caught-observer-throws') assert.equal(injected, 1)
  if (mode === 'observer-throws' || mode === 'caught-observer-throws')
    assert(names.includes('observer-throw'))
  if (mode === 'viewport-reject') {
    assert(names.includes('rejected-explicit-viewport-rpc'))
    assert(names.includes('client-viewport-rejected'))
  }
  const endStatus = ordinary.endStatus()
  assert.equal(endStatus.status, mode === 'clean' ? 'passed' : 'failed')
  const expectedExit = mode === 'clean' ? 0 : 1
  assert.equal(process.exitCode ?? 0, expectedExit)
  await writeFile(
    `${report}/desktop-${mode}.json`,
    JSON.stringify(
      {
        scope:
          'Normal desktop Chromium with accessor test double, no Waffle binding or retirement credit',
        expectedExit,
        endStatus,
        events,
        normal,
        emissions: emissions.map(({ kind, url }) => ({ kind, url })),
      },
      null,
      2,
    ),
  )
  process.exitCode = 0
} finally {
  await context?.close()
}

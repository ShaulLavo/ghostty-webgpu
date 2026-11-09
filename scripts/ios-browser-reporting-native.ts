import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isAbsolute, resolve } from 'node:path'
import { createVitest } from 'vitest/node'
import type { Plugin, ViteDevServer } from 'vite'
import {
  createFrameworkHost,
  type FrameworkResult,
  type FrameworkHost,
} from 'waffle/testing/page-runner/framework'
import { attachedGhosttyProvider, ghosttyFrameworkPlugin } from './ios-browser.ts'
import { ReportingNodeOwner } from './ios-browser-reporting-owner.ts'
import {
  ReportingFixtureController,
  parseReportingState,
  type ReportingMode,
} from './ios-browser-reporting-controller.ts'
import { reportingSyntheticNames, reportingFullName } from './ios-browser-reporting-manifest.ts'
import { frameworkEndReporter } from './ios-browser-report.ts'
import { checkNativeRuntime } from './ios-browser-options.ts'

const errorNames = [
  'reporting refusal remains infrastructure only',
  'official update and both error paths survive reporting refusal',
  'official update returns its original result after refusal',
]
export function reportingSelection(mode: ReportingMode) {
  if (mode === 'matrix')
    return {
      file: resolve('scripts/ios-browser-reporting.synthetic.browser.test.ts'),
      names: reportingSyntheticNames.map(reportingFullName),
    }
  if (mode === 'flush')
    return {
      file: resolve('scripts/ios-browser-reporting-flush.synthetic.browser.test.ts'),
      names: ['real throttling and final flush retain separate RPC and ACK owners'],
    }
  return {
    file: resolve('scripts/ios-browser-reporting-errors.synthetic.browser.test.ts'),
    names: errorNames,
  }
}

export function reportingFixturePlugin(
  mode: ReportingMode,
  servers: Set<ViteDevServer>,
  owner?: ReportingNodeOwner,
): Plugin {
  return {
    name: 'ghostty-page-owned-reporting-fixture',
    enforce: 'pre',
    configureServer(server) {
      servers.add(server)
      if (server.httpServer && owner)
        owner.ownFixture(
          new Promise<void>((resolve) => server.httpServer?.once('close', resolve)),
          `vite-http-close:${server.config.server.port}`,
        )
      server.middlewares.use(realmAsset)
    },
    resolveId(id) {
      if (id === '/@ghostty/reporting-fixture')
        return fileURLToPath(new URL('./ios-browser-reporting-page.ts', import.meta.url))
    },
    transform(code, id) {
      if (!id.includes('/tester-') || !code.includes('function unhandledError(e, type)')) return
      const setup = `import { installReportingTrace } from '/@ghostty/reporting-fixture';\ninstallReportingTrace(${JSON.stringify(mode)});\n`
      const endpoint =
        mode === 'matrix' || mode === 'flush'
          ? ''
          : '\nReflect.set(globalThis, Symbol.for("ghostty.synthetic.tester-errors"), { unhandledError, client });\n'
      return setup + code + endpoint
    },
  }
}

export function assertReportingResult(mode: ReportingMode, result: FrameworkResult): void {
  assert.equal(result.framework?.status, 'passed', 'Ordinary task outcomes must remain unchanged')
  assert.equal(
    result.trace.status,
    'confirmed',
    'Only final tester evidence qualifies this fixture',
  )
  if (result.trace.status !== 'confirmed') throw new Error('Missing final trace')
  const final = parseReportingState(result.trace.artifact.text)
  if (mode !== 'matrix' && mode !== 'flush') {
    assert.equal(result.exit, 2)
    assert.equal(result.fileComplete, false)
    assert.equal(result.cases.length, 3)
    assert(
      result.cases.every((item) => item.outcome === null),
      'All three negative collector outcomes must stay unreported',
    )
    assert(final.errorTrace)
    const errors = final.errorTrace.filter(
      (item) => item.kind === 'rpc' && item.source !== 'Synthetic capacity error',
    )
    assert.deepEqual(
      errors.map((item) => item.source),
      ['Synthetic tester error', 'Error', 'Cleanup Error'],
    )
    assert(final.errorTrace.some((item) => item.kind === 'update-after-refusal'))
    return
  }
  assert.equal(result.exit, 4)
  assert.equal(result.fileComplete, true)
  assert.equal(result.rootBrowserSuiteComplete, false)
  assert.deepEqual(result.failures, [])
  const selected = reportingSelection(mode)
  assert.equal(
    result.collection.filter((task) => task.type === 'test').length,
    selected.names.length,
  )
  if (mode !== 'matrix') return
  assert.equal(final.clocks.filter((clock) => clock.kind === 'body').length, 38)
  assert(
    final.clocks.every(
      (clock) =>
        clock.taskTimeout === 15000 &&
        clock.hookTimeout === 30000 &&
        typeof clock.elapsed === 'number' &&
        clock.elapsed >= 0,
    ),
  )
}

export async function executeReportingNative(options: {
  mode: ReportingMode
  udid: string
  output: string
  port: number
  apiPort: number
}): Promise<number> {
  const owner = new ReportingNodeOwner()
  const fixture = new ReportingFixtureController(options.mode)
  const selected = reportingSelection(options.mode)
  const servers = new Set<ViteDevServer>()
  const host = createFrameworkHost({
    suite: `ghostty-reporting-${options.mode}`,
    native: { udid: options.udid },
    expected: selected.names.map((fullName, index) => ({
      file: selected.file,
      fullName,
      sourceKey: `reporting:${index}`,
      timeoutMs: 15000,
      retries: 0,
    })),
    scope: { kind: 'root-selection', command: 'test:browser', files: [selected.file] },
    resultPath: resolve(options.output, 'sdk-result.json'),
  })
  const capture = host.captureTesterTrace({ collectorResponse: fixture.collectorResponse })
  fixture.arm(capture)
  const end = frameworkEndReporter()
  const watchdog = setTimeout(() => {
    void host.abort('Finite installed reporting control deadline')
  }, 25000)
  let result: FrameworkResult
  try {
    result = await host.run((registerClose) =>
      owner.ownExecution(
        executeFixture({ host, owner, fixture, selected, servers, end, options, registerClose }),
        `createVitest.start:${selected.file}`,
      ),
    )
  } finally {
    clearTimeout(watchdog)
  }
  await owner
    .ownFixture(
      Promise.resolve().then(() => verifyServers(servers)),
      'actual Vite websocket and HTTP consumers',
    )
    .catch(() => {})
  const ownership = await owner.finish(result)
  let qualification: { status: 'passed' } | { status: 'failed'; detail: string } = {
    status: 'passed',
  }
  try {
    assertReportingResult(options.mode, result)
  } catch (error) {
    qualification = { status: 'failed', detail: String(error) }
  }
  await writeFile(
    resolve(options.output, 'runner-ownership.json'),
    JSON.stringify(
      {
        process: { pid: process.pid, parentPid: process.ppid, cwd: process.cwd() },
        ownership,
        laterObservations: owner.observations(),
        qualification,
        gates: Array.from(fixture.gates, ([kind, gate]) => ({ kind, status: gate.status })),
        reads: fixture.reads,
        collector: fixture.observations,
        nativeExecutionClaim: false,
        originalExecutionClaim: false,
      },
      null,
      2,
    ),
  )
  if (qualification.status === 'failed') {
    console.error(qualification.detail)
    return 2
  }
  return ownership.exit
}

export async function reportingNativeMain(args: readonly string[]): Promise<number> {
  if (args.length !== 10)
    throw new Error(
      'Use --mode matrix|flush|errors|capacity|malformed --udid UUID --output NEW_ABSOLUTE_DIRECTORY --port PORT --api-port PORT',
    )
  const flags = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index],
      value = args[index + 1]
    if (
      !key ||
      !value ||
      flags.has(key) ||
      !['--mode', '--udid', '--output', '--port', '--api-port'].includes(key)
    )
      throw new Error('Invalid reporting arguments')
    flags.set(key, value)
  }
  const mode = flags.get('--mode'),
    udid = flags.get('--udid'),
    output = flags.get('--output')
  const port = Number(flags.get('--port')),
    apiPort = Number(flags.get('--api-port'))
  if (
    mode !== 'matrix' &&
    mode !== 'flush' &&
    mode !== 'errors' &&
    mode !== 'capacity' &&
    mode !== 'malformed'
  )
    throw new Error('Explicit reporting mode required')
  if (
    !udid ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(udid) ||
    !output ||
    !isAbsolute(output)
  )
    throw new Error('Explicit native UUID and new absolute output required')
  if (
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    !Number.isInteger(apiPort) ||
    apiPort < 1024 ||
    apiPort > 65535 ||
    port === apiPort
  )
    throw new Error('Two distinct explicit ports required')
  checkNativeRuntime({ version: process.version, platform: process.platform })
  await mkdir(output)
  return executeReportingNative({ mode, udid, output, port, apiPort })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await reportingNativeMain(process.argv.slice(2)).catch((error) => {
    console.error(error)
    return 2
  })

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

type Execution = {
  host: FrameworkHost
  owner: ReportingNodeOwner
  fixture: ReportingFixtureController
  selected: ReturnType<typeof reportingSelection>
  servers: Set<ViteDevServer>
  end: ReturnType<typeof frameworkEndReporter>
  options: Parameters<typeof executeReportingNative>[0]
  registerClose: Parameters<Parameters<FrameworkHost['run']>[0]>[0]
}
async function executeFixture(input: Execution) {
  const { host, owner, fixture, selected, servers, end, options, registerClose } = input
  const context = await createVitest(
    'test',
    { config: false, watch: false, root: process.cwd() },
    {
      plugins: [ghosttyFrameworkPlugin(host), reportingFixturePlugin(options.mode, servers, owner)],
      server: { port: options.port, strictPort: true },
      test: {
        include: [selected.file],
        testTimeout: 15000,
        hookTimeout: 30000,
        retry: 0,
        isolate: true,
        fileParallelism: false,
        reporters: ['default', end.reporter],
        api: { port: options.apiPort, strictPort: true },
        browser: {
          enabled: true,
          provider: attachedGhosttyProvider(host),
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
  owner.ownContext(context, `vitest:${selected.file}:${options.port}:${options.apiPort}`)
  registerClose(() => {
    fixture.cancel()
    return owner.closeContext()
  })
  const controls = owner.ownFixture(fixture.run(), `fixture:${options.mode}`)
  void controls.catch(() => fixture.cancel())
  await context.start([selected.file])
  await controls
  return end.endStatus()
}
function verifyServers(servers: ReadonlySet<ViteDevServer>): void {
  for (const server of servers)
    assert(
      !server.httpServer?.listening && server.ws.clients.size === 0,
      'Actual Vite consumers remain',
    )
}

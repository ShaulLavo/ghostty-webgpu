import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'vitest'
import { createVitest } from 'vitest/node'
import { build, type Plugin } from 'vite'
import {
  FrameworkCollector,
  frameworkEvent,
  type DocumentKind,
} from '../node_modules/waffle/tests/page-runner/framework-collector.ts'
import type {
  FrameworkEvent,
  FrameworkMiddlewareStack,
  FrameworkUpdate,
} from 'waffle/testing/page-runner/framework'
import { createBrowserTestConfig } from '../vitest.browser.config.ts'
import { ghosttyFrameworkPlugin } from './ios-browser.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const file = fileURLToPath(
  new URL('./fixtures/ios-browser/dynamic-skip.browser.test.ts', import.meta.url),
)
const names = [
  'missing sync',
  'missing async',
  'worker capability',
  'supported acquisition fails',
  'sibling still runs',
  'GPU hook > missing beforeEach',
]

function observation(value: unknown): { role: DocumentKind; event: FrameworkEvent } | undefined {
  assert(value && typeof value === 'object')
  const role: unknown = Reflect.get(value, 'role')
  assert(role === 'tester' || role === 'orchestrator')
  const kind: unknown = Reflect.get(value, 'event')
  const detail: unknown = Reflect.get(value, 'detail')
  let event: unknown = { kind }
  if (kind === 'collected') event = { kind, tasks: detail }
  if (kind === 'task-started') event = { kind, id: detail }
  if (kind === 'task-update' || kind === 'case-settled') event = { kind, updates: detail }
  if (!frameworkEvent(event)) return
  return { role, event }
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString())
}

function createCollector() {
  const collector = new FrameworkCollector(
    names.map((fullName) => ({
      file,
      fullName,
      sourceKey: fullName,
      timeoutMs: 15000,
      retries: 0,
    })),
  )
  collector.viewportConsumed = true
  const roles = ['tester', 'orchestrator'] as const
  const documents = new Map(
    roles.map((role) => {
      const document = collector.expect(role, `http://control/${role}`)
      collector.receive({
        run: collector.run,
        token: document.token,
        doc: role,
        seq: 0,
        kind: 'hello',
        role,
        url: document.url,
      })
      document.admitted = true
      return [role, document] as const
    }),
  )
  const cleaned = new Map<string, Set<string>>()
  function receive(role: (typeof roles)[number], event: FrameworkEvent): void {
    if (event.kind === 'case-settled') verifyCleanup(collector, cleaned, event.updates)
    const document = documents.get(role)
    assert(document)
    collector.receive({
      run: collector.run,
      token: document.token,
      doc: document.doc,
      seq: document.messages.length,
      kind: 'event',
      event,
    })
  }
  return { collector, cleaned, receive }
}

type Probe = ReturnType<typeof createCollector>

function verifyCleanup(
  collector: FrameworkCollector,
  cleaned: Probe['cleaned'],
  updates: readonly FrameworkUpdate[],
): void {
  for (const update of updates) {
    const task = collector.collection.find((task) => task.id === update.id)
    assert(task)
    assert.deepEqual(cleaned.get(task.id), new Set(['afterEach', 'aroundEach']))
  }
}

async function receive(probe: Probe, request: IncomingMessage, response: ServerResponse) {
  const value = await body(request)
  if (request.url === '/ghostty-local-cleanup') {
    assert(value && typeof value === 'object' && 'name' in value && 'phase' in value)
    assert(typeof value.name === 'string' && typeof value.phase === 'string')
    const phases = probe.cleaned.get(value.name) ?? new Set<string>()
    phases.add(value.phase)
    probe.cleaned.set(value.name, phases)
  } else {
    const payload = observation(value)
    if (payload) probe.receive(payload.role, payload.event)
  }
  response.end('ACK')
}

function reportFailure(errors: unknown[], response: ServerResponse, error: unknown): void {
  errors.push(error)
  response.statusCode = 500
  response.end(String(error))
}

function middleware(
  probe: Probe,
  errors: unknown[],
): Parameters<FrameworkMiddlewareStack['use']>[0] {
  return (request, response, next) => {
    if (request.url !== '/ghostty-local-event' && request.url !== '/ghostty-local-cleanup')
      return next()
    void receive(probe, request, response).catch(reportFailure.bind(null, errors, response))
  }
}

function collectorPlugin(probe: Probe, observer: string, errors: unknown[]): Plugin {
  return ghosttyFrameworkPlugin({
    mount(stack) {
      stack.use(middleware(probe, errors))
    },
    instrumentDocument({ html }) {
      return html.replace(
        '<head>',
        `<head><script>${observer.replaceAll('</script', '<\\/script')}</script>`,
      )
    },
  })
}

async function close(
  context: Awaited<ReturnType<typeof createVitest>> | undefined,
  scratch: string,
  exitCode: typeof process.exitCode,
): Promise<void> {
  try {
    await context?.close()
  } finally {
    process.exitCode = exitCode
    await rm(scratch, { recursive: true, force: true })
  }
}

// Real patched browser events and the installed collector; no native session or Safari credit.
test('dynamic skips settle once after every cleanup and preserve non-passing outcomes', async () => {
  const scratch = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), 'gskip-'))
  const exitCode = process.exitCode
  const probe = createCollector()
  const errors: unknown[] = []
  let context: Awaited<ReturnType<typeof createVitest>> | undefined
  try {
    await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        outDir: scratch,
        lib: {
          entry: join(root, 'scripts/fixtures/ios-browser/desktop-observer.ts'),
          formats: ['es'],
          fileName: () => 'observer.js',
        },
      },
    })
    const observer = await readFile(join(scratch, 'observer.js'), 'utf8')
    const base = createBrowserTestConfig()
    const plugin = collectorPlugin(probe, observer, errors)
    context = await createVitest(
      'test',
      { root, config: false, watch: false, reporters: [] },
      {
        ...base,
        plugins: base.plugins.concat(plugin),
        test: {
          ...base.test,
          api: { port: 0 },
          include: [file],
          testTimeout: 15000,
          hookTimeout: 30000,
          retry: 0,
          browser: {
            ...base.test.browser,
            commands: { __ghostty_initialViewport: async () => {} },
          },
        },
      },
    )
    await context.start([file])
    assert.deepEqual(context.state.getUnhandledErrors(), [])
    assert.deepEqual(errors, [])
    const outcomes = probe.collector.cases.map((row) => row.outcome?.state)
    assert.deepEqual(outcomes.slice(0, 2), ['skip', 'skip'])
    assert(outcomes[2] === 'skip' || outcomes[2] === 'pass')
    assert.deepEqual(outcomes.slice(3), ['fail', 'pass', 'skip'])
    const settlements = probe.collector.events.filter((event) => event.kind === 'case-settled')
    assert.equal(settlements.length, names.length)
    assert(probe.collector.cases.every((row) => row.started))
    assert(
      JSON.stringify(probe.collector.cases[3]?.outcome).includes('CONTROL_ACQUISITION_FAILURE'),
    )
    assert.deepEqual(probe.collector.failures, [])
    assert(
      probe.collector.executionFlushed &&
        probe.collector.cleanupSettled &&
        probe.collector.cleanupResponse,
    )
  } finally {
    await close(context, scratch, exitCode)
  }
  assert.equal(Reflect.has(globalThis, Symbol.for('ghostty.framework.instrumentDocument')), false)
}, 30000)

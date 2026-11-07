import assert from 'node:assert/strict'
import { test } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  parseNativeArguments,
  checkNativeRuntime,
  NativePreconditionError,
} from './ios-browser-options.ts'
import { nativeStage } from './ios-browser-stages.ts'
import { parseHostSummary, joinedExit } from './ios-browser-result.ts'
import { getGlobalDispatcher } from 'undici'
import {
  runFrameworkNode,
  OwnedFrameworkDispatcher,
  joinFrameworkExecution,
} from './ios-browser-node.ts'
import { resultFixture } from './fixtures/ios-browser/result-fixture.ts'
import { verifyNativeStage } from './ios-browser-verify.ts'
import { nativeProcessLimits, runNodeProcess } from './ios-browser-process.ts'

const sample = [
  '--stage',
  'synthetic',
  '--udid',
  '00000000-0000-0000-0000-000000000000',
  '--result',
  '/not-executed/local-fixture.json',
]
const script = fileURLToPath(new URL('./fixtures/ios-browser/process-fixture.ts', import.meta.url))
const cwd = process.cwd()
const outcome = { kind: 'exited', code: 4, signal: null, joined: true } satisfies Awaited<
  ReturnType<typeof runNodeProcess>
>
const cleanup = Object.fromEntries(
  ['session', 'launcher', 'callbacks', 'provider', 'context', 'scratch'].map((key) => [
    key,
    { status: 'confirmed', detail: 'local fixture' },
  ]),
)
const host = {
  exit: 4,
  fileComplete: true,
  rootBrowserSuiteComplete: false,
  framework: { status: 'failed' },
  cleanup,
}

test('explicit parser rejects missing, duplicate, relative, unknown and malformed arguments', () => {
  assert.deepEqual(parseNativeArguments(['--help']), { kind: 'help' })
  assert.equal(parseNativeArguments(sample).kind, 'run')
  assert.throws(() => parseNativeArguments([]), NativePreconditionError)
  assert.throws(() => parseNativeArguments(['--stage', 'synthetic']), NativePreconditionError)
  assert.throws(
    () =>
      parseNativeArguments([
        '--stage',
        'synthetic',
        '--stage',
        'viewport',
        '--result',
        '/not-executed/x.json',
      ]),
    NativePreconditionError,
  )
  assert.throws(
    () => parseNativeArguments(sample.slice(0, 5).concat('relative.json')),
    NativePreconditionError,
  )
  assert.throws(
    () =>
      parseNativeArguments([
        '--stage',
        'synthetic',
        '--udid',
        'guess',
        '--result',
        '/not-executed/x.json',
      ]),
    NativePreconditionError,
  )
})

test('runtime preconditions reject unsupported host/version without native work', () => {
  assert.throws(
    () => checkNativeRuntime({ version: 'v26.12.1', platform: 'linux' }),
    NativePreconditionError,
  )
  assert.throws(
    () => checkNativeRuntime({ version: 'v22.23.4', platform: 'darwin' }),
    NativePreconditionError,
  )
  checkNativeRuntime({ version: 'v26.12.1', platform: 'darwin' })
})

test('independent synthetic and original selections preserve exact clocks and original count', () => {
  const synthetic = nativeStage('synthetic')
  const viewport = nativeStage('viewport')
  assert.equal(synthetic.expected.length, 1)
  assert.equal(viewport.expected.length, 5)
  assert.notEqual(synthetic.file, viewport.file)
  assert(
    synthetic.expected
      .concat(viewport.expected)
      .every((row) => row.timeoutMs === 15000 && row.retries === 0),
  )
  assert.deepEqual(nativeProcessLimits, { wallMs: 960000, interruptGraceMs: 12000 })
})

test('actual result boundary keeps partial 4 and infrastructure 2 precedence', () => {
  const summary = parseHostSummary(host)
  assert.equal(summary.framework, 'failed')
  assert.equal(joinedExit(outcome, summary), 4)
  assert.equal(joinedExit({ ...outcome, code: 2 }, summary), 2)
  assert.equal(joinedExit({ ...outcome, joined: false }, summary), 2)
  assert.equal(joinedExit({ ...outcome, code: 0 }, summary), 2)
  assert.equal(joinedExit(outcome, null), 2)
  assert.equal(joinedExit({ ...outcome, code: 3 }, null), 3)
  assert.throws(() => parseHostSummary({ ...host, rootBrowserSuiteComplete: true }))
  assert.throws(() => parseHostSummary({ ...host, framework: null }))
  assert.throws(() => parseHostSummary({ ...host, framework: { status: ['passed'] } }))
})

test('joined local child returns its real partial exit without invoking a native entry', async () => {
  const result = await runNodeProcess(
    { script, args: ['partial'], cwd, signal: new AbortController().signal },
    { wallMs: 2000, interruptGraceMs: 50 },
  )
  assert.deepEqual(result, outcome)
})

test('owned local timeout forces and joins only its child process group', async () => {
  const result = await runNodeProcess(
    { script, args: ['hang'], cwd, signal: new AbortController().signal },
    { wallMs: 100, interruptGraceMs: 50 },
  )
  assert.equal(result.kind, 'failed')
  assert.equal(result.joined, true)
  if (result.kind === 'failed') assert.equal(result.reason, 'timeout')
})

test('owned interruption joins a local child that ignores TERM', async () => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 150)
  try {
    const result = await runNodeProcess(
      { script, args: ['ignore-term'], cwd, signal: controller.signal },
      { wallMs: 2000, interruptGraceMs: 50 },
    )
    assert.equal(result.kind, 'failed')
    assert.equal(result.joined, true)
    if (result.kind === 'failed') assert.equal(result.reason, 'interrupted')
  } finally {
    clearTimeout(timer)
  }
})

test('outer and worker help/invalid argument paths acquire no native resource', () => {
  for (const file of ['ios-browser-launch.ts', 'ios-browser-main.ts']) {
    const path = fileURLToPath(new URL('./' + file, import.meta.url))
    const help = spawnSync(process.execPath, [path, '--help'], { encoding: 'utf8' })
    assert.equal(help.status, 0, help.stderr)
    assert.match(help.stdout, /Usage:/)
    const invalid = spawnSync(process.execPath, [path, '--stage', 'synthetic'], {
      encoding: 'utf8',
    })
    assert.equal(invalid.status, 3, invalid.stderr)
  }
})

test('transport remains open until actual execution joins, including a failed early close', async () => {
  const completed = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  let active: OwnedFrameworkDispatcher | undefined
  let closes = 0
  const close = async () => {
    closes++
    if (closes === 1) throw new Error('LOCAL_CLOSE_FAILURE')
  }
  const running = runFrameworkNode(async () => {
    const current = getGlobalDispatcher()
    assert(current instanceof OwnedFrameworkDispatcher)
    active = current
    entered.resolve()
    await assert.rejects(joinFrameworkExecution(close, completed.promise), /LOCAL_CLOSE_FAILURE/)
  })
  await entered.promise
  assert.equal(active?.closed, false)
  completed.resolve()
  await running
  assert.equal(closes, 2)
  assert.equal(active?.closed, true)
})

test('read-only staging gate requires actual observed ACK fields rather than accepted counts', () => {
  const fixtureOnly = resultFixture()
  const receipt = { exit: 4, outcome }
  verifyNativeStage('synthetic', fixtureOnly, receipt)
  assert.throws(
    () =>
      verifyNativeStage(
        'synthetic',
        {
          ...fixtureOnly,
          documents: fixtureOnly.documents.map((document) => ({
            ...document,
            ackedThrough: null,
            pending: null,
          })),
        },
        receipt,
      ),
    /observed ACKs/,
  )
  assert.throws(() => verifyNativeStage('viewport', fixtureOnly, receipt), /inventory/)
})

test('a close rejection with undefined remains an infrastructure failure after join', async () => {
  let rejected = false
  const failedClose = Promise.withResolvers<void>()
  failedClose.reject(undefined)
  await joinFrameworkExecution(() => failedClose.promise, Promise.resolve()).then(
    () => {
      throw new Error('Unexpected successful close')
    },
    () => {
      rejected = true
    },
  )
  assert.equal(rejected, true)
})

test('the owning root command exposes only an explicit native route and preserves desktop forwarding', () => {
  const native = spawnSync('bun', ['scripts/browser-tests.ts', '--native-ios', '--help'], {
    encoding: 'utf8',
    timeout: 10000,
  })
  assert.equal(native.status, 0, native.stderr)
  assert.match(native.stdout, /ios-browser-launch/)
  const desktop = spawnSync('bun', ['scripts/browser-tests.ts', '--help'], {
    encoding: 'utf8',
    timeout: 10000,
  })
  assert.equal(desktop.status, 0, desktop.stderr)
  assert.match(desktop.stdout, /vitest/)
})

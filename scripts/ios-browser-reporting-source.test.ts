import { expect, test } from 'vitest'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reportingSyntheticCases } from './ios-browser-reporting-cases.ts'
import { reportingSyntheticNames } from './ios-browser-reporting-manifest.ts'

const browserRoot = dirname(fileURLToPath(import.meta.resolve('@vitest/browser/package.json')))
async function tester(): Promise<string> {
  return readFile(join(browserRoot, 'dist/client/__vitest_browser__/tester-COH68OX9.js'), 'utf8')
}

test('the permanent installed fixture registers 38 distinct synthetic bodies', () => {
  expect(reportingSyntheticCases.map((row) => row.name)).toEqual(reportingSyntheticNames)
  expect(new Set(reportingSyntheticNames).size).toBe(38)
  expect(reportingSyntheticCases.every((row) => typeof row.run === 'function')).toBe(true)
})

test('the installed update keeps its original RPC and direct result return', async () => {
  const source = await tester()
  const start = source.indexOf('_defineProperty(this, "onTaskUpdate",')
  const end = source.indexOf('_defineProperty(this, "importFile",', start)
  const body = source.slice(start, end)
  expect(body).toContain('const result = rpc$2().onTaskUpdate(this.method, task, events);')
  expect(body).toContain(
    'try { ghostty.taskUpdated?.(task); } catch (error) { console.error(error); }',
  )
  expect(body).toContain('return result;')
  expect(body).not.toMatch(/await|\.then\(|Promise\.|signal/)
})

test('tester and browser errors retain distinct original complete expressions', async () => {
  const source = await tester()
  const start = source.indexOf('function unhandledError(e, type)')
  const end = source.indexOf('function isEvent', start)
  const body = source.slice(start, end)
  expect(body).toContain('ghostty.caughtError?.(e, type)')
  expect(body).toContain(
    'return client.rpc.onUnhandledError({\n\t\tname: e.name,\n\t\tmessage: e.message,\n\t\tstack: e.stack\n\t}, type).catch(() => {});',
  )
  expect(body).not.toMatch(/serializeError|await|Promise\.|signal/)
  const catcher = await readFile(join(browserRoot, 'dist/client/error-catcher.js'), 'utf8')
  const report = catcher.slice(
    catcher.indexOf('async function reportUnexpectedError('),
    catcher.indexOf('globalThis.__vitest_browser_runner__.disposeExceptionTracker'),
  )
  expect(report.match(/serializeError\(error\)/g)).toHaveLength(1)
  expect(report).toContain(
    'await client.waitForConnection().then(() => {\n    return client.rpc.onUnhandledError(processedError, type)\n  }).catch(console.error)',
  )
  expect(catcher).toContain(
    "const offError = catchWindowErrors('error', 'error', event =>\n    reportUnexpectedError('Error', event.error))",
  )
})

test('execute and actual cleanup waits remain before their original response owner', async () => {
  const source = await tester()
  expect(source).toContain(
    'else await executeTests("run", files).catch((err) => unhandledError(err, "Run Error"));\n\t\t\t\tawait ghostty.executionFlushed?.();',
  )
  expect(source).toContain(
    'await traces.finish();\n\t\t\t\tawait ghostty.testerCleanupSettled?.();',
  )
  expect(source).toContain('event: `response:${data.event}`')
  const suiteStart = source.indexOf('_defineProperty(this, "onBeforeRunSuite",')
  const suiteEnd = source.indexOf('_defineProperty(this, "onAfterRunFiles",', suiteStart)
  const suite = source.slice(suiteStart, suiteEnd)
  expect(suite).toContain('const reporting = ghostty.taskStarted?.(suite);')
  expect(suite).toContain('} finally {\n\t\t\t\t\tawait reporting;')
  expect(suite).not.toContain('.catch(')
})

test('reporting control code stays within three block levels', async () => {
  const { parseSync } = await import('oxc-parser')
  const paths = [
    'scripts/ios-browser-page.ts',
    'scripts/ios-browser-records.ts',
    'scripts/ios-browser-reporting-installed.ts',
    'scripts/ios-browser-reporting-realm.ts',
    'scripts/ios-browser-reporting-cases.ts',
    'scripts/ios-browser-reporting.synthetic.browser.test.ts',
    'scripts/ios-browser-reporting-errors.synthetic.browser.test.ts',
    'scripts/ios-browser-reporting-flush.synthetic.browser.test.ts',
    'scripts/ios-browser-reporting-host.test.ts',
    'scripts/ios-browser-reporting.test.ts',
  ]
  for (const path of paths) {
    const parsed = parseSync(path, await readFile(path, 'utf8'))
    expect(parsed.errors, path).toEqual([])
    expect(blockDepth(parsed.program), path).toBeLessThanOrEqual(3)
  }
})

function blockDepth(value: unknown, depth = 0): number {
  if (!value || typeof value !== 'object') return depth
  if (Array.isArray(value)) return Math.max(depth, ...value.map((item) => blockDepth(item, depth)))
  const current = 'type' in value && value.type === 'BlockStatement' ? depth + 1 : depth
  let maximum = current
  for (const child of Object.values(value)) maximum = Math.max(maximum, blockDepth(child, current))
  return maximum
}

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { realpathSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'oxc-parser'
import { test } from 'vitest'
import { nativeStage } from './ios-browser-stages.ts'
import { verifyNativeSource } from './ios-browser-source.ts'
import { frameworkRelease, checkFrameworkArchive } from './ios-browser-dependency.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)

test('the published test-tool dependency stays dev-only, locked, and singly resolved', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.devDependencies.waffle, frameworkRelease.url)
  assert.equal(manifest.dependencies.waffle, undefined)
  assert.equal(manifest.devDependencies.undici, '6.29.1')
  assert.equal(manifest.devDependencies['@vitest/browser'], '5.0.2')
  const lock = await readFile(join(root, 'bun.lock'), 'utf8')
  assert(
    lock.includes(
      '"sha512-83zffXOSjEmildyP6FG2vryezZem81S6ggASb9GlRkjQAtHojqOQPMfYJ4kDkTKx90x7geBMfiXco9sE5Be81g=="',
    ),
  )
  const browser = realpathSync(require.resolve('@vitest/browser/package.json'))
  for (const provider of ['@vitest/browser-webdriverio', '@vitest/browser-playwright']) {
    const consumer = createRequire(require.resolve(provider))
    assert.equal(realpathSync(consumer.resolve('@vitest/browser/package.json')), browser)
  }
  const installed = JSON.parse(
    await readFile(
      new URL('../../../package.json', import.meta.resolve('waffle/testing/page-runner/framework')),
      'utf8',
    ),
  )
  assert.equal(installed.name, 'waffle')
  assert.equal(installed.version, frameworkRelease.version)
  assert.equal(
    installed.exports['./testing/page-runner/framework'].node,
    './dist/tests/page-runner/framework.js',
  )
  assert.equal(
    installed.exports['./testing/page-runner/framework-page'].browser,
    './tests/page-runner/framework-page.ts',
  )
  const productFiles = readdirSync(join(root, 'src'), {
    recursive: true,
    withFileTypes: true,
  }).filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
  for (const entry of productFiles) {
    const source = await readFile(join(entry.parentPath, entry.name), 'utf8')
    assert(!source.includes('waffle/testing/page-runner'), `${entry.name} imports the test host`)
  }
  await assert.rejects(checkFrameworkArchive(fileURLToPath(import.meta.url)), /published Waffle/)
})

test('each native stage binds an independent complete manifest to unchanged source', async () => {
  for (const stage of ['synthetic', 'viewport', 'bulk-snapshot', 'font-resources', 'measurement'] as const) {
    await verifyNativeSource(stage)
    const selected = nativeStage(stage)
    const source = await readFile(selected.file, 'utf8')
    const parsed = parseSync(selected.file, source)
    assert.deepEqual(parsed.errors, [])
    const names = registrations(parsed.program.body)
    assert.deepEqual(
      names,
      selected.expected.map((row) => row.fullName),
    )
    assert(selected.expected.every((row) => row.timeoutMs === 15000 && row.retries === 0))
  }
  assert.equal(nativeStage('viewport').expected.length, 5)
  assert.equal(nativeStage('bulk-snapshot').expected.length, 1)
  assert.equal(nativeStage('font-resources').expected.length, 5)
  assert.equal(nativeStage('measurement').expected.length, 4)
})

type Statement = ReturnType<typeof parseSync>['program']['body'][number]
function registrations(statements: readonly Statement[], prefix = ''): string[] {
  return statements.flatMap((statement) => registration(statement, prefix))
}
function registration(statement: Statement, prefix: string): string[] {
  if (statement.type !== 'ExpressionStatement' || statement.expression.type !== 'CallExpression')
    return []
  const call = statement.expression
  if (call.callee.type === 'CallExpression') return parameterizedRegistration(call, prefix)
  if (call.callee.type !== 'Identifier' || !['describe', 'test', 'it'].includes(call.callee.name))
    return []
  const [name, body] = call.arguments
  assert(name?.type === 'Literal' && typeof name.value === 'string')
  const fullName = prefix + name.value
  if (call.callee.name !== 'describe') {
    assert.equal(call.arguments.length, 2)
    return [fullName]
  }
  assert(body?.type === 'ArrowFunctionExpression' && body.body.type === 'BlockStatement')
  return registrations(body.body.body, fullName + ' > ')
}

type Call = Extract<
  Extract<Statement, { type: 'ExpressionStatement' }>['expression'],
  { type: 'CallExpression' }
>
function parameterizedRegistration(call: Call, prefix: string): string[] {
  assert(call.callee.type === 'CallExpression')
  const each = call.callee
  assert(each.callee.type === 'MemberExpression' && !each.callee.computed)
  assert(each.callee.object.type === 'Identifier' && each.callee.object.name === 'it')
  assert(each.callee.property.type === 'Identifier' && each.callee.property.name === 'each')
  assert.equal(each.arguments.length, 1)
  const argument = each.arguments[0]
  const table = argument?.type === 'TSAsExpression' ? argument.expression : argument
  assert(table?.type === 'ArrayExpression' && table.elements.length > 0)
  const [name, body] = call.arguments
  assert.equal(call.arguments.length, 2)
  assert(name?.type === 'Literal' && typeof name.value === 'string')
  assert.equal(name.value.match(/%s/g)?.length, 1)
  assert(body?.type === 'ArrowFunctionExpression' && body.body.type === 'BlockStatement')
  return table.elements.map((item) => {
    assert(item?.type === 'Literal' && typeof item.value === 'string')
    return prefix + name.value.replace('%s', item.value)
  })
}

test('font parameter inventory rejects changed tables, titles, and per-case options', async () => {
  const selected = nativeStage('font-resources')
  const source = await readFile(selected.file, 'utf8')
  const expectedNames = selected.expected.map((row) => row.fullName)
  const mutations = [
    source.replace("['dispose', 'family-change']", "['dispose', 1]"),
    source.replace('after %s', 'after %i'),
    source.replace("['dispose', 'family-change']", "['dispose', 'family-change', 'extra']"),
    source.replace('after %s', 'instead of %s'),
    source.replace('  },\n)', '  },\n  { timeout: 1 },\n)'),
  ]
  for (const changed of mutations) {
    assert.notEqual(changed, source)
    const parsed = parseSync(selected.file, changed)
    assert.deepEqual(parsed.errors, [])
    assert.throws(() => assert.deepEqual(registrations(parsed.program.body), expectedNames))
  }
})

test('the page bridge bundles without host, SDK, or Node imports', async () => {
  const { build } = await import('vite')
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      lib: { entry: join(root, 'scripts/ios-browser-page.ts'), formats: ['es'] },
    },
  })
  const builds = Array.isArray(result) ? result : [result]
  for (const built of builds) {
    assert('output' in built)
    const imports = built.output.flatMap((chunk) => (chunk.type === 'chunk' ? chunk.imports : []))
    const code = built.output.map((chunk) => (chunk.type === 'chunk' ? chunk.code : '')).join('\n')
    assert.deepEqual(imports, [])
    assert(!/node:|webdriverio|createFrameworkHost|OwnedFrameworkDispatcher/.test(code))
  }
})

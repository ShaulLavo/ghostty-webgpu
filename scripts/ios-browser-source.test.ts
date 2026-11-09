import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { realpathSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'oxc-parser'
import { test } from 'vitest'
import { nativeStage } from './ios-browser-stages.ts'
import { nativeSourceHashes, verifyNativeSource } from './ios-browser-source.ts'
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
      `"waffle": ["waffle@${frameworkRelease.url}", { "hasInstallScript": true }, "${frameworkRelease.integrity}"]`,
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
  assert.equal(installed.waffleHostInterface, frameworkRelease.hostInterface)
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
  for (const stage of [
    'synthetic',
    'viewport',
    'bulk-snapshot',
    'font-resources',
    'measurement',
    'write-queue',
    'presentation',
    'scrollbar-async',
    'history',
    'readline-layout',
    'module-mock',
    'font-fixture',
    'font-geometry',
    'canvas-rasterizer',
    'stamp-cache',
    'pixel-damage',
    'mounted-scroll',
    'dom-appearance',
    'managed-fallback',
  ] as const) {
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
  assert(
    each.callee.property.type === 'Identifier' &&
      ['each', 'for'].includes(each.callee.property.name),
  )
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
    if (item?.type === 'Identifier' && item.name === 'undefined')
      return prefix + name.value.replace('%s', 'undefined')
    assert(
      item?.type === 'Literal' &&
        (typeof item.value === 'string' || typeof item.value === 'number'),
    )
    return prefix + name.value.replace('%s', String(item.value))
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

test('measurement parameter parity rejects changed rows, titles, and case options', async () => {
  const selected = nativeStage('measurement')
  const source = await readFile(selected.file, 'utf8')
  const expected = selected.expected.map((row) => row.fullName)
  const mutations = [
    source.replace("['title', 'data']", "['title', 1]"),
    source.replace("['title', 'data']", "['title']"),
    source.replace('public %s observers', 'public %i observers'),
    source.replace('public %s observers', 'other %s observers'),
    source.replace('    },\n  )', '    },\n    { timeout: 1 },\n  )'),
  ]
  for (const changed of mutations) {
    assert.notEqual(changed, source)
    const parsed = parseSync(selected.file, changed)
    assert.deepEqual(parsed.errors, [])
    assert.throws(() => assert.deepEqual(registrations(parsed.program.body), expected))
  }
})

test('presentation parity rejects omitted, duplicate, substituted parameters and changed options', async () => {
  const selected = nativeStage('presentation')
  const source = await readFile(selected.file, 'utf8')
  const expected = selected.expected.map((row) => row.fullName)
  const mutations = [
    source.replace("[undefined, 'canvas2d-fill-text']", "['canvas2d-fill-text']"),
    source.replace("[undefined, 'canvas2d-fill-text']", '[undefined, undefined]'),
    source.replace("[undefined, 'canvas2d-fill-text']", "[null, 'canvas2d-fill-text']"),
    source.replace('next frame (%s)', 'next frame (%i)'),
    source.replace('next frame (%s)', 'another frame (%s)'),
    source.replace('  },\n)', '  },\n  { timeout: 1 },\n)'),
  ]
  for (const changed of mutations) {
    assert.notEqual(changed, source)
    const parsed = parseSync(selected.file, changed)
    assert.deepEqual(parsed.errors, [])
    assert.throws(() => assert.deepEqual(registrations(parsed.program.body), expected))
  }
})

test('history and multiline parity rejects omitted, duplicate, renamed and modified originals', async () => {
  for (const stage of ['history', 'readline-layout'] as const) {
    const selected = nativeStage(stage)
    const source = await readFile(selected.file, 'utf8')
    const expected = selected.expected.map((row) => row.fullName)
    const mutations = [
      source.replace("  it('reads empty rows", "  it.skip('reads empty rows"),
      source.replace("['main', 'worker']", "['main']"),
      source.replace("['main', 'worker']", "['main', 'main']"),
      source.replace('built native history API in Chromium', 'renamed suite'),
      source.replace(
        "  it('reads empty rows before opening with the same lifecycle guard as visibleLines', async () => {",
        "  it('reads empty rows before opening with the same lifecycle guard as visibleLines', { timeout: 1 }, async () => {",
      ),
      source.replace("it('renders and submits", "it.skip('renders and submits"),
      source.replace('preserves earlier output and pending wrap', 'renamed multiline case'),
      source.replace(
        "it('renders and submits logical LF and prints above an active multiline edit through the built addon', async () => {",
        "it('renders and submits logical LF and prints above an active multiline edit through the built addon', { retry: 1 }, async () => {",
      ),
      source + "\nit('substituted extra case', () => {})\n",
    ].filter((changed) => changed !== source)
    for (const changed of mutations) {
      assert.notEqual(createHash('sha256').update(changed).digest('hex'), nativeSourceHashes[stage])
      const parsed = parseSync(selected.file, changed)
      assert.deepEqual(parsed.errors, [])
      assert.throws(() => assert.deepEqual(registrations(parsed.program.body), expected))
    }
  }
})

test('the text batch keeps original helper clocks, cleanup, font and built imports', async () => {
  const history = await readFile(nativeStage('history').file, 'utf8')
  assert(
    history.includes(
      "import { Terminal, TERMINAL_READ_LINES_MAX_ROWS } from '../../../dist/index.js'",
    ),
  )
  assert(
    history.includes("import { Terminal as WorkerTerminal } from '../../../dist/worker/index.js'"),
  )
  assert(history.includes('Array.from({ length: 20000 }, (_, index) => `row-${index}`)'))
  assert(history.includes('start += TERMINAL_READ_LINES_MAX_ROWS'))
  assert(history.includes('for (const terminal of terminals.splice(0)) await terminal.dispose()'))
  assert(history.includes('url: testFontUrl'))
  const readline = await readFile(nativeStage('readline-layout').file, 'utf8')
  assert(
    readline.includes("import { readline } from '../../../packages/line-editor/dist/index.js'"),
  )
  assert(readline.includes('for (const cleanup of cleanups.splice(0).reverse()) cleanup()'))
  assert(readline.includes('setTimeout(resolve, 0)'))
  assert(
    readline.includes(
      "terminal.key({ action: 'press', code: 'Enter', text: '\\r', composing: false })",
    ),
  )
  assert(readline.includes('expect.soft(terminal.geometry().cursor)'))
  for (const [stage, changed] of [
    ['history', history.replace('length: 20000', 'length: 1')],
    ['readline-layout', readline.replace('setTimeout(resolve, 0)', 'setTimeout(resolve, 1)')],
  ] as const)
    assert.notEqual(createHash('sha256').update(changed).digest('hex'), nativeSourceHashes[stage])
  const font = await readFile(
    join(
      root,
      'node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2',
    ),
  )
  assert.equal(font.byteLength, 21168)
  assert.equal(
    createHash('sha256').update(font).digest('hex'),
    '14425ba9c695763c1547f48a206b7aa60350a33ae23de09f0407877f3fcd89eb',
  )
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

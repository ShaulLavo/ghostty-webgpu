import assert from 'node:assert/strict'
import { readFile, mkdir, rmdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createVitest, type BrowserCommandContext, type TestProject } from 'vitest/node'
import { webdriverio } from '@vitest/browser-webdriverio'
import { resolveScreenshotPath } from '@vitest/browser'
import { isFileLoadingAllowed } from 'vite'
import { test, vi } from 'vitest'
import { createBrowserTestConfig } from '../vitest.browser.config.ts'
import { nativeUsage, parseNativeArguments } from './ios-browser-options.ts'
import { nativeSourceHashes, verifyNativeSource } from './ios-browser-source.ts'
import { nativeStage } from './ios-browser-stages.ts'
import { verifyNativeStage } from './ios-browser-verify.ts'
import { resultFixture, receiptFixture } from './fixtures/ios-browser/result-fixture.ts'
import type {} from './ios-browser.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

const stage = 'canvas-scroll'
const selected = nativeStage(stage)
const root = fileURLToPath(new URL('../', import.meta.url))
type CaptureOptions = Parameters<
  import('vitest/internal/browser').BrowserCommands['__vitest_takeScreenshot']
>[1]

function originalCaptures(source: string): CaptureOptions[] {
  const sites = Array.from(source.matchAll(/await page\.screenshot\((\{[\s\S]*?\n\s*\})\)/g))
  assert.deepEqual(
    sites.map((site) => source.slice(0, site.index).split('\n').length),
    [243, 515, 538],
  )
  const canvas = { selector: '#original-candidate-canvas', locator: 'canvas' }
  const evaluate = (site: (typeof sites)[number] | undefined, unicode: boolean) => {
    assert(site)
    const options: unknown = new Function(
      'f',
      'unicode',
      'candidateGlyphs',
      'fullGlyphs',
      `return (${site[1]})`,
    )({ canvas }, unicode, 7, 42)
    assert(options && typeof options === 'object' && 'path' in options)
    assert(typeof options.path === 'string')
    assert.deepEqual(Object.keys(options), ['element', 'path'])
    assert('element' in options && options.element === canvas)
    return { element: canvas, path: options.path }
  }
  return [evaluate(sites[0], false), evaluate(sites[0], true)].concat([
    evaluate(sites[1], false),
    evaluate(sites[2], false),
  ])
}

async function checkOfficialCapture({
  project,
  file,
  commandContext,
  options,
  directory,
  lookupReached,
}: {
  project: TestProject
  file: string
  commandContext: BrowserCommandContext
  options: CaptureOptions
  directory: string
  lookupReached: Error
}): Promise<void> {
  assert(project.browser)
  const parent: unknown = Reflect.get(project.browser, 'parent')
  assert(parent && typeof parent === 'object' && 'commands' in parent)
  assert(parent.commands && typeof parent.commands === 'object')
  const screenshot: unknown = Reflect.get(parent.commands, '__vitest_screenshot')
  assert(typeof screenshot === 'function')
  const path = resolveScreenshotPath(file, 'original-capture', project.config, options.path)
  assert.equal(dirname(path), directory)
  assert(isFileLoadingAllowed(project.vite.config, path))
  assert(isFileLoadingAllowed(project.vitest.vite.config, path))
  assert.equal(project.config.api.allowWrite, true)
  assert.equal(project.vitest.config.api.allowWrite, true)
  assert(!('save' in options))
  const keys = Object.keys(options)
  const scale = options.scale
  const element = options.element
  const customPath = options.path
  await assert.rejects(
    async () => {
      await screenshot(commandContext, 'original-capture', options)
    },
    (reason) => reason === lookupReached,
  )
  assert.equal(options.save, true)
  assert.equal(options.element, element)
  assert.equal(options.path, customPath)
  assert.equal(options.scale, scale)
  assert.deepEqual(Object.keys(options), keys.concat('save'))
}

async function closeCaptureContext(
  context: Awaited<ReturnType<typeof createVitest>> | undefined,
  created: string | undefined,
  directory: string,
): Promise<void> {
  try {
    await context?.close()
  } finally {
    if (created) await rmdir(directory)
  }
}

test('canvas scroll selects all 15 unchanged rows with the original source identities and clocks', async () => {
  const request = parseNativeArguments([
    '--stage',
    stage,
    '--udid',
    '00000000-0000-0000-0000-000000000000',
    '--result',
    '/not-executed/canvas-scroll.json',
  ])
  assert.equal(request.kind, 'run')
  if (request.kind !== 'run') throw new Error('Expected an explicit run request')
  assert.equal(request.options.stage, stage)
  assert.equal(selected.file, join(root, 'src/render/canvas/scroll.browser.test.ts'))
  await verifyNativeSource(stage)
  assert.equal(
    nativeSourceHashes[stage],
    '7e84e87bfea3408774a4caaa517dda7e80e1dd53dec5954803ff55e01e2769c0',
  )
  const sites = [
    '213:0',
    '213:1',
    '250:0',
    '273:0',
    '296:0',
    '322:0',
    '365:0',
    '365:1',
    '403:0',
    '424:0',
    '424:1',
    '475:0',
    '494:0',
    '544:0',
    '590:0',
  ]
  assert.deepEqual(
    selected.expected.map((row) => row.sourceKey),
    sites.map((site) => `src/render/canvas/scroll.browser.test.ts:${site}`),
  )
  assert(
    selected.expected.every(
      (row) => row.file === selected.file && row.timeoutMs === 15000 && row.retries === 0,
    ),
  )
  const source = await readFile(selected.file, 'utf8')
  assert.equal(source.split('\n').length - 1, 609)
  assert.equal(source.match(/\bit(?:\.each)?\(/g)?.length, 12)
  assert(!source.includes('page.viewport'))
  const runner = await readFile(new URL('./ios-browser-run.ts', import.meta.url), 'utf8')
  assert(runner.includes('testTimeout: 15000,\n      hookTimeout: 30000,\n      retry: 0,'))
})

test('canvas scroll identity rejects table, capture, clock, oracle and cleanup changes', async () => {
  const source = await readFile(selected.file, 'utf8')
  const replacements: readonly (readonly [string, string])[] = [
    ['[false, true]', '[false]'],
    ["['copy', 'paint']", "['copy']"],
    ["['fill-text', 'pixels']", "['fill-text']"],
    ['await page.screenshot({', 'void page.screenshot({'],
    ['element: f.canvas,', 'element: f.control,'],
    ['element: f.canvas,', 'element: f.canvas, save: false,'],
    ['element: f.canvas,', "element: f.canvas, scale: 'css',"],
    ['canvas-scroll-${unicode', 'other-scroll-${unicode'],
    ['canvas-pixels-styled-zwj-parity0.png', 'other-styled.png'],
    ['canvas-pixels-native-parity0.png', 'other-native.png'],
    ['if (index === 5)', 'if (index === 500)'],
    ['expect(different, label).toBe(0)', 'expect(different, label).toBeLessThan(10)'],
    ['new FrameClock()', 'new DifferentClock()'],
    ['.splice(0).reverse()', '.splice(0)'],
    ['beforeAll(async () => {', 'beforeAll(async () => { /* changed hook */'],
    ["it('handles multi-row", "it.skip('handles multi-row"],
  ]
  for (const [before, after] of replacements) {
    const changed = source.replace(before, after)
    assert.notEqual(changed, source, before)
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from(changed))
    await assert.rejects(verifyNativeSource(stage), /Native manifest source changed/)
  }
  vi.mocked(readFile).mockResolvedValueOnce(Buffer.from(source + '\n'))
  await assert.rejects(verifyNativeSource(stage), /Native manifest source changed/)
  await verifyNativeSource(stage)
})

test('six original Canvas scroll, legacy text and hotkey captures reach official permission checks', async () => {
  const source = await readFile(selected.file, 'utf8')
  const captures = originalCaptures(source)
  assert.deepEqual(
    captures.map((options) => options.path),
    [
      '../../../.artifacts/canvas-scroll-ascii-copied5-painted1-glyphs7-full42-parity0.png',
      '../../../.artifacts/canvas-scroll-unicode-copied5-painted1-glyphs7-full42-parity0.png',
      '../../../.artifacts/canvas-pixels-styled-zwj-parity0.png',
      '../../../.artifacts/canvas-pixels-native-parity0.png',
    ],
  )
  const originals = [{ file: selected.file, captures }]
  for (const stage of ['legacy-text', 'hotkeys-focus'] as const) {
    const { file } = nativeStage(stage)
    const source = await readFile(file, 'utf8')
    const sites = Array.from(source.matchAll(/await page\.screenshot\((\{[\s\S]*?\})\)/g))
    assert.equal(sites.length, 1)
    const expression = sites[0]?.[1]
    assert(expression)
    const element = { selector: '#original-element', locator: 'original' }
    const observed: unknown = new Function(
      'host',
      'f',
      'entry',
      `return (${expression.replace('element!', 'element')})`,
    )(element, { terminal: { element } }, 'main')
    const options: CaptureOptions =
      stage === 'legacy-text'
        ? { element, path: '../.artifacts/bench-legacy-graphemes.png' }
        : { element, path: '../../../../.artifacts/terminal205-main.png', scale: 'css' }
    assert.deepEqual(observed, options)
    originals.push({ file, captures: [options] })
  }
  const base = createBrowserTestConfig()
  const directory = join(root, '.artifacts')
  let created: string | undefined
  let context: Awaited<ReturnType<typeof createVitest>> | undefined
  try {
    created = await mkdir(directory, { recursive: true })
    const before = await readdir(directory)
    context = await createVitest(
      'test',
      { config: false, watch: false, root },
      {
        ...base,
        test: {
          ...base.test,
          include: [],
          browser: {
            ...base.test.browser,
            provider: webdriverio(),
            instances: [{ browser: 'safari' }],
            commands: {},
          },
        },
      },
    )
    const project = context.projects[0]
    assert(project?.browser)
    const browser = project.browser
    await browser.initBrowserProvider(project)
    const lookupReached = new Error('CPU contract test stops before any browser lookup or pixels')
    const commandContext: BrowserCommandContext = {
      project,
      provider: browser.provider,
      sessionId: 'cpu-contract-only',
      testPath: selected.file,
      mark: async () => {},
      triggerCommand: (name, ...args) => browser.triggerCommand(name, commandContext, ...args),
      get browser(): never {
        throw lookupReached
      },
      get page(): never {
        throw new Error('Unexpected Playwright access')
      },
      get frame(): never {
        throw new Error('Unexpected Playwright access')
      },
      get iframe(): never {
        throw new Error('Unexpected Playwright access')
      },
      get context(): never {
        throw new Error('Unexpected Playwright access')
      },
    }
    for (const original of originals) {
      commandContext.testPath = original.file
      for (const options of original.captures)
        await checkOfficialCapture({
          project,
          file: original.file,
          commandContext,
          options,
          directory,
          lookupReached,
        })
    }
    assert.deepEqual(await readdir(directory), before)
  } finally {
    await closeCaptureContext(context, created, directory)
  }
})

test('canvas scroll rejects any missing row, altered identity, failure, retry or incomplete cleanup', () => {
  const result = resultFixture(stage)
  verifyNativeStage(stage, result, receiptFixture)
  for (let index = 0; index < result.cases.length; index++)
    assert.throws(() =>
      verifyNativeStage(
        stage,
        {
          ...result,
          cases: result.cases.filter((_row, at) => at !== index),
        },
        receiptFixture,
      ),
    )
  const altered = [
    result.cases.concat(result.cases.slice(0, 1)),
    result.cases.map((row) => ({ ...row, expected: { ...row.expected, fullName: 'substitute' } })),
    result.cases.map((row) => ({ ...row, expected: { ...row.expected, sourceKey: 'other' } })),
    result.cases.map((row) => ({ ...row, expected: { ...row.expected, timeoutMs: 20000 } })),
    result.cases.map((row) => ({ ...row, actualId: 'repeated' })),
    result.cases.map((row) => ({ ...row, outcome: { ...row.outcome, state: 'fail' } })),
    result.cases.map((row) => ({ ...row, outcome: { ...row.outcome, state: 'skip' } })),
    result.cases.map((row) => ({ ...row, outcome: { ...row.outcome, retryCount: 1 } })),
  ]
  for (const cases of altered)
    assert.throws(() => verifyNativeStage(stage, { ...result, cases }, receiptFixture))
  assert.throws(() =>
    verifyNativeStage(stage, { ...result, rootBrowserSuiteComplete: true }, receiptFixture),
  )
  assert.throws(() => verifyNativeStage(stage, { ...result, cleanup: {} }, receiptFixture))
})

test('canvas scroll appears in launcher and saved-result verifier help', async () => {
  const verifier = await readFile(new URL('./ios-browser-verify.ts', import.meta.url), 'utf8')
  const usage = verifier.match(/Usage: node scripts\/ios-browser-verify\.ts ([^ ]+) /)?.[1]
  assert(usage)
  assert.equal(usage, nativeUsage.split('--stage ')[1]?.split(' --udid')[0])
  assert(usage.split('|').includes(stage))
})

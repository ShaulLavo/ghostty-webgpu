import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test, vi } from 'vitest'
import { parseNativeArguments } from './ios-browser-options.ts'
import { nativeSourceHashes, verifyNativeSource } from './ios-browser-source.ts'
import { nativeStage } from './ios-browser-stages.ts'
import { verifyNativeStage } from './ios-browser-verify.ts'
import { resultFixture, receiptFixture } from './fixtures/ios-browser/result-fixture.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

const stage = 'dom-appearance'
const selected = nativeStage(stage)
const file = 'src/render/dom/appearance-retention.browser.test.ts'

function digest(source: string): string {
  return createHash('sha256').update(source).digest('hex')
}

test('DOM appearance selects the whole original with its real font, geometry, callbacks and clocks', async () => {
  const request = parseNativeArguments([
    '--stage', stage, '--udid', '00000000-0000-0000-0000-000000000000',
    '--result', '/not-executed/dom-appearance.json',
  ])
  assert.equal(request.kind, 'run')
  if (request.kind !== 'run') throw new Error('Expected an explicit run request')
  assert.equal(request.options.stage, stage)
  await verifyNativeSource(stage)
  const source = await readFile(selected.file, 'utf8')
  const registration = source.split('\n')[16]
  assert.equal(registration, `it('${selected.expected[0]?.fullName}', async () => {`)
  assert.deepEqual(selected.expected.map(({ fullName, sourceKey }) => ({ fullName, sourceKey })), [{
    fullName: 'retains cursor appearance rows while publishing frames and observing current geometry',
    sourceKey: `${file}:17:0`,
  }])
  assert(selected.expected.every((row) => row.timeoutMs === 15000 && row.retries === 0))
  assert.equal(source.match(/\bexpect\(/g)?.length, 17)
  assert.equal(source.match(/await settle\(\)/g)?.length, 10)
  assert.equal(source.match(/cleanups.push\(/g)?.length, 4)
  assert(source.includes('await new FontFace(family, `url(${JSON.stringify(url)})`).load()'))
  assert(source.includes('for (let index = 0; index < 3; index += 1)'))
  assert(source.includes('requestAnimationFrame(() => resolve())'))
  assert(source.includes('for (const cleanup of cleanups.reverse()) cleanup()'))
  assert.equal(source.match(/expect\.poll\(/g), null)
  assert.equal(source.match(/vi\.|page\.|userEvent\./g), null)
  const helper = await readFile(new URL('../src/tests/fonts.ts', import.meta.url), 'utf8')
  assert(helper.includes('@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url'))
  assert(helper.includes('new URL(fontUrl, import.meta.url).href'))
})

test('DOM appearance source gate rejects changed font, assertions, geometry, reentrancy, clocks and cleanup', async () => {
  const source = await readFile(selected.file, 'utf8')
  const replacements: readonly (readonly [string, string])[] = [
    ['new FontFace(family,', 'new FontFace("substituted",'],
    ['document.fonts.add(face)', 'document.fonts.clear()'],
    ['document.fonts.delete(face)', 'document.fonts.clear()'],
    ['await GhosttyRuntime.create()', 'await Promise.resolve(undefined)'],
    ['DomTerminalRenderer.create(options)', 'Promise.resolve(undefined)'],
    ['index < 3', 'index < 1'],
    ['requestAnimationFrame(() => resolve())', 'queueMicrotask(() => resolve())'],
    ['await settle()', 'await Promise.resolve()'],
    ['paintedRows - before).toBe(1)', 'paintedRows - before).toBe(12)'],
    ["{ style: 'bar', visible: false }", "{ style: 'block', visible: false }"],
    ['canvas.offsetLeft + parseFloat(getComputedStyle(canvas).paddingLeft)', '0'],
    [".toBe('rgb(18, 52, 86)')", ".toBe('rgb(0, 0, 0)')"],
    ['.toBe(originalPalette)', '.toBe(undefined)'],
    ['runtime.exports.memory.grow(1)', 'runtime.exports.memory.grow(0)'],
    ['if (reentered) return', 'if (!reentered) return'],
    ['frames).toBe(reentrantFrames + 2)', 'frames).toBe(reentrantFrames + 1)'],
    ['.toBe(retained)', '.toBe(undefined)'],
    ['subscription.dispose()', 'terminal.clear()'],
    ['cleanups.reverse()', 'cleanups'],
    ['cleanups.length = 0', 'cleanups.length = 1'],
    ['terminal.dispose()', 'terminal.clear()'],
    ['runtime.dispose()', 'runtime.createTerminal()'],
    ['host.remove()', 'host.replaceChildren()'],
    ["it('retains", "it.skip('retains"],
  ]
  for (const [before, after] of replacements) {
    const changed = source.replace(before, after)
    assert.notEqual(changed, source, before)
    assert.notEqual(digest(changed), nativeSourceHashes[stage])
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from(changed))
    await assert.rejects(verifyNativeSource(stage), /Native manifest source changed/)
  }
  vi.mocked(readFile).mockResolvedValueOnce(Buffer.from(source + "\nit('extra', () => {})\n"))
  await assert.rejects(verifyNativeSource(stage), /Native manifest source changed/)
  await verifyNativeSource(stage)
})

test('DOM appearance rejects incomplete, substituted, failed or retried outcomes', () => {
  const result = resultFixture(stage)
  verifyNativeStage(stage, result, receiptFixture)
  for (const changes of [
    { exit: 0 },
    { rootBrowserSuiteComplete: true },
    { cases: [] },
    { cases: result.cases.slice(1) },
    { cases: result.cases.concat(result.cases.slice(0, 1)) },
    { cases: result.cases.map((row) => ({ ...row, started: false })) },
    {
      cases: result.cases.map((row) => ({
        ...row,
        expected: { ...row.expected, sourceKey: 'other' },
      })),
    },
    {
      cases: result.cases.map((row) => ({
        ...row,
        expected: { ...row.expected, fullName: 'other' },
      })),
    },
    { cases: result.cases.map((row) => ({ ...row, expected: { ...row.expected, timeoutMs: 1 } })) },
    { cases: result.cases.map((row) => ({ ...row, outcome: { ...row.outcome, retryCount: 1 } })) },
    { cases: result.cases.map((row) => ({ ...row, outcome: { ...row.outcome, state: 'fail' } })) },
    { cases: result.cases.map((row) => ({ ...row, outcome: { ...row.outcome, state: 'skip' } })) },
  ])
    assert.throws(() => verifyNativeStage(stage, { ...result, ...changes }, receiptFixture))
  assert.throws(() => verifyNativeStage(stage, resultFixture('mounted-scroll'), receiptFixture))
  assert.throws(() => verifyNativeStage(stage, result, { ...receiptFixture, exit: 0 }))
})

test('DOM appearance keeps exact retirement ACKs and finite fractional cutoffs', () => {
  const result = resultFixture(stage)
  const documents = result.documents.map((row) => ({
    ...row,
    acceptedThrough: 0,
    ackedThrough: 0,
    cutoff: 0.25,
  }))
  verifyNativeStage(stage, { ...result, documents }, receiptFixture)
  for (const changes of [
    { acceptedThrough: 1 },
    { pending: 1 },
    { acceptedThrough: -1, ackedThrough: -1 },
    { acceptedThrough: 0.5, ackedThrough: 0.5 },
    { acceptedThrough: Number.MAX_SAFE_INTEGER + 1, ackedThrough: Number.MAX_SAFE_INTEGER + 1 },
    { cutoff: -1 },
    { cutoff: Infinity },
    { cutoff: NaN },
  ])
    assert.throws(() =>
      verifyNativeStage(
        stage,
        { ...result, documents: documents.map((row) => ({ ...row, ...changes })) },
        receiptFixture,
      ),
    )
})

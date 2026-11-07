import assert from 'node:assert/strict'
import { test } from 'vitest'
import { verifyNativeStage } from './ios-browser-verify.ts'

import { resultFixture, receiptFixture as receipt } from './fixtures/ios-browser/result-fixture.ts'

function resultWithCutoffs(top: unknown, tester: unknown) {
  const result = resultFixture()
  return {
    ...result,
    documents: result.documents.map((document) => ({
      ...document,
      cutoff: document.kind === 'orchestrator' ? top : tester,
    })),
  }
}

test('accepts fractional host-clock cutoffs independently of integer sequence counters', () => {
  assert.doesNotThrow(() =>
    verifyNativeStage('synthetic', resultWithCutoffs(5093.332083, 5088.484125), receipt),
  )
})

test('accepts zero and integer cutoff timestamps', () => {
  assert.doesNotThrow(() => verifyNativeStage('synthetic', resultWithCutoffs(0, 12), receipt))
})

test('rejects non-finite and negative cutoffs in either document', () => {
  for (const cutoff of [NaN, Infinity, -Infinity, -1]) {
    assert.throws(() => verifyNativeStage('synthetic', resultWithCutoffs(cutoff, 12), receipt))
    assert.throws(() => verifyNativeStage('synthetic', resultWithCutoffs(12, cutoff), receipt))
  }
})

test('still rejects fractional, unsafe, non-finite, negative and unobserved sequence counters', () => {
  for (const count of [0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, -1]) {
    const result = resultWithCutoffs(12, 13)
    for (const document of result.documents) {
      document.acceptedThrough = count
      document.ackedThrough = count
    }
    assert.throws(() => verifyNativeStage('synthetic', result, receipt))
  }
  const result = resultWithCutoffs(12, 13)
  const documents = result.documents.map((document) => ({ ...document, ackedThrough: null }))
  assert.throws(() => verifyNativeStage('synthetic', { ...result, documents }, receipt))
})

test('requires separate documents and rejects unresolved failures or substituted identities', () => {
  const result = resultFixture()
  const documents = result.documents.map((document) => ({ ...document, doc: 'reused-document' }))
  assert.throws(() => verifyNativeStage('synthetic', { ...result, documents }, receipt))
  assert.throws(() =>
    verifyNativeStage(
      'synthetic',
      { ...result, failures: [{ category: 'infrastructure', detail: 'fixture failure' }] },
      receipt,
    ),
  )
  assert.throws(() => verifyNativeStage('synthetic', { ...result, binding: {} }, receipt))
  assert.throws(() => verifyNativeStage('synthetic', { ...result, geometry: {} }, receipt))
  const cases = result.cases.map((row) => ({
    ...row,
    expected: { ...row.expected, fullName: 'substituted' },
  }))
  assert.throws(() => verifyNativeStage('synthetic', { ...result, cases }, receipt))
})

test('all complete selections stay partial and reject missing or duplicate outcomes', () => {
  for (const stage of [
    'synthetic',
    'viewport',
    'bulk-snapshot',
    'font-resources',
    'measurement',
    'write-queue',
    'presentation',
    'scrollbar-async',
  ] as const) {
    const result = resultFixture(stage)
    verifyNativeStage(stage, result, receipt)
    assert.throws(() => verifyNativeStage(stage, { ...result, exit: 0 }, receipt))
    assert.throws(() =>
      verifyNativeStage(stage, { ...result, rootBrowserSuiteComplete: true }, receipt),
    )
    assert.throws(() => verifyNativeStage(stage, { ...result, cases: [] }, receipt))
    assert.throws(() =>
      verifyNativeStage(stage, { ...result, cases: result.cases.concat(result.cases) }, receipt),
    )
    assert.throws(() =>
      verifyNativeStage(
        stage,
        { ...result, cases: result.cases.map((row) => ({ ...row, started: false })) },
        receipt,
      ),
    )
  }
})

test('the CLI checks recorded files without rewriting either input', async () => {
  const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawnSync } = await import('node:child_process')
  const scratch = await mkdtemp(join(tmpdir(), 'ghostty-verifier-'))
  try {
    const path = join(scratch, 'result.json')
    const result = JSON.stringify(resultFixture())
    const launcher = JSON.stringify(receipt)
    await writeFile(path, result)
    await writeFile(`${path}.launcher.json`, launcher)
    const verified = spawnSync('node', ['scripts/ios-browser-verify.ts', 'synthetic', path], {
      encoding: 'utf8',
      timeout: 5000,
    })
    assert.equal(verified.status, 0, verified.stderr)
    assert.match(verified.stdout, /"rootBrowserSuiteComplete":false/)
    assert.equal(await readFile(path, 'utf8'), result)
    assert.equal(await readFile(`${path}.launcher.json`, 'utf8'), launcher)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

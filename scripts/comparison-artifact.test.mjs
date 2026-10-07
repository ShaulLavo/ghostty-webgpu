import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { readComparisonArtifact, writeComparisonArtifact } from './comparison-artifact.mjs'

test('streams the same pretty JSON and final metadata as the original artifact writer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'comparison-artifact-'))
  try {
    const path = join(directory, 'comparison.json')
    const artifact = {
      schema: 1,
      runs: [{ phase: 'synthetic', text: '\n"\\\u0000é😀\ud800', absent: undefined }],
      values: [undefined, NaN, Infinity, -0],
      date: new Date('2026-01-01T00:00:00Z'),
      finishedAt: 'fixture-finished',
      error: 'fixture-error',
    }
    await writeComparisonArtifact(path, artifact)
    assert.equal(await readFile(path, 'utf8'), JSON.stringify(artifact, null, 2) + '\n')
    assert.deepEqual(await readComparisonArtifact(path), JSON.parse(JSON.stringify(artifact)))
    assert.deepEqual(await readdir(directory), ['comparison.json'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('streamed reading retains native JSON prototype-key behavior', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'comparison-artifact-keys-'))
  try {
    const path = join(directory, 'comparison.json')
    const source = '{"__proto__":{"marker":true},"constructor":17,"runs":[]}'
    await writeFile(path, source)
    const artifact = await readComparisonArtifact(path)
    assert.deepEqual(artifact, JSON.parse(source))
    assert.equal(Object.getPrototypeOf(artifact), Object.prototype)
    assert.equal(Object.hasOwn(artifact, '__proto__'), true)
    assert.deepEqual(await readdir(directory), ['comparison.json'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('streamed reading propagates malformed JSON and missing-file errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'comparison-artifact-read-error-'))
  try {
    const path = join(directory, 'comparison.json')
    await assert.rejects(readComparisonArtifact(path), { code: 'ENOENT' })
    await writeFile(path, '{"runs":[')
    await assert.rejects(readComparisonArtifact(path), SyntaxError)
    assert.deepEqual(await readdir(directory), ['comparison.json'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('streamed gzip reading preserves trace data and rejects corrupt or truncated input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'comparison-artifact-gzip-'))
  try {
    const path = join(directory, 'trace.json.gz')
    const trace = { traceEvents: [{ name: 'synthetic', args: { text: 'é😀' } }] }
    await writeFile(path, gzipSync(JSON.stringify(trace)))
    assert.deepEqual(await readComparisonArtifact(path, { gzip: true }), trace)
    await writeFile(path, gzipSync('{"traceEvents":['))
    await assert.rejects(readComparisonArtifact(path, { gzip: true }), SyntaxError)
    await writeFile(path, 'invalid gzip')
    await assert.rejects(readComparisonArtifact(path, { gzip: true }))
    await assert.rejects(readComparisonArtifact(join(directory, 'missing.gz'), { gzip: true }), {
      code: 'ENOENT',
    })
    assert.deepEqual(await readdir(directory), ['trace.json.gz'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('keeps the last complete checkpoint when serialization fails after emitting data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'comparison-artifact-error-'))
  try {
    const path = join(directory, 'comparison.json')
    const previous = '{"finishedAt":"previous"}\n'
    await writeFile(path, previous)
    const artifact = { prefix: 'x'.repeat(128 * 1024), unsupported: 1n }
    await assert.rejects(writeComparisonArtifact(path, artifact), TypeError)
    assert.equal(await readFile(path, 'utf8'), previous)
    assert.deepEqual(await readdir(directory), ['comparison.json'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('cleans partial output when a cyclic artifact cannot be serialized', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'comparison-artifact-cycle-'))
  try {
    const artifact = { runs: [] }
    artifact.runs.push(artifact)
    await assert.rejects(
      writeComparisonArtifact(join(directory, 'comparison.json'), artifact),
      TypeError,
    )
    assert.deepEqual(await readdir(directory), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

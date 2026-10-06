import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const phases = ['select', 'implement', 'screen', 'qualify', 'keep', 'reject', 'baseline', 'stopped']

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function readCheckpoint(path) {
  try {
    const bytes = await readFile(path)
    return { sha256: digest(bytes), checkpoint: JSON.parse(bytes.toString()) }
  } catch (error) {
    if (error.code === 'ENOENT') return { sha256: 'new', checkpoint: null }
    throw error
  }
}

function validateCheckpoint(next) {
  assert(next && typeof next === 'object' && !Array.isArray(next), 'Checkpoint object required')
  assert(['dry-run', 'research'].includes(next.mode), 'Explicit dry-run or research mode required')
  assert(phases.includes(next.phase), 'Unknown research phase')
  assert(typeof next.nextAction === 'string' && next.nextAction.length > 0, 'Next action required')
  assert(
    Array.isArray(next.references) && next.references.length > 0,
    'Authority references required',
  )
  assert(next.budget && typeof next.budget === 'object', 'Research budget required')
  assert(Number.isSafeInteger(next.budget.maxExperiments) && next.budget.maxExperiments > 0)
  assert(
    Number.isSafeInteger(next.budget.completedExperiments) && next.budget.completedExperiments >= 0,
  )
  assert(Number.isFinite(next.budget.maxMinutes) && next.budget.maxMinutes > 0)
  assert(Number.isFinite(Date.parse(next.budget.startedAt)), 'Budget start time required')
  assert(
    next.budget.completedExperiments <= next.budget.maxExperiments,
    'Experiment budget exceeded',
  )
  if (['keep', 'reject'].includes(next.phase)) {
    assert(typeof next.experiment?.id === 'string' && next.experiment.id.length > 0)
    assert.equal(next.experiment.outcome, next.phase.toUpperCase(), 'Decision must match phase')
  }
}

async function validateContinuation(path, current, next) {
  if (!current) return
  assert.equal(next.mode, current.mode, 'Use a new checkpoint for a new run mode')
  for (const key of ['startedAt', 'maxExperiments', 'maxMinutes'])
    assert.equal(next.budget[key], current.budget[key], 'Run budget is fixed')
  assert(
    next.budget.completedExperiments >= current.budget.completedExperiments,
    'Budget count decreased',
  )
  validateCompletedExperiment(current, next)
  const files = await readdir(`${path}.history`)
  for (const file of files) {
    const bytes = await readFile(`${path}.history/${file}`)
    assert.equal(file, `${digest(bytes)}.json`, 'History digest changed')
    const previous = JSON.parse(bytes.toString())
    validateCompletedExperiment(previous, next)
  }
}

function validateCompletedExperiment(previous, next) {
  if (
    !['keep', 'reject'].includes(previous.phase) ||
    previous.experiment.id !== next.experiment?.id
  )
    return
  assert.deepEqual(
    next.experiment,
    previous.experiment,
    'Completed experiment is immutable; use a new identity',
  )
  assert(
    next.phase === previous.phase || ['select', 'baseline', 'stopped'].includes(next.phase),
    'Completed experiment cannot restart',
  )
}

async function preserveSnapshot(path, bytes) {
  const history = `${path}.history`
  await mkdir(history, { recursive: true })
  const snapshot = `${history}/${digest(bytes)}.json`
  try {
    await writeFile(snapshot, bytes, { flag: 'wx' })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    assert.deepEqual(await readFile(snapshot), Buffer.from(bytes), 'History bytes changed')
  }
}

export async function writeCheckpoint(path, expected, next) {
  validateCheckpoint(next)
  await mkdir(dirname(path), { recursive: true })
  const lock = `${path}.lock`
  await mkdir(`${path}.history`, { recursive: true })
  await mkdir(lock)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(
      `${lock}/owner.json`,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    )
    const current = await readCheckpoint(path)
    assert.equal(current.sha256, expected, 'Checkpoint changed; read it before continuing')
    await validateContinuation(path, current.checkpoint, next)
    if (current.checkpoint) await preserveSnapshot(path, await readFile(path))
    const bytes = JSON.stringify(next, null, 2) + '\n'
    await writeFile(temporary, bytes, { flag: 'wx' })
    await rename(temporary, path)
    await preserveSnapshot(path, bytes)
    return { sha256: digest(bytes), checkpoint: next }
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
    await unlink(`${lock}/owner.json`).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
    await rmdir(lock)
  }
}

async function main(args) {
  const [command, file, expected, input] = args
  assert(
    file &&
      ((command === 'read' && args.length === 2) || (command === 'write' && args.length === 4)),
    'Usage: autoresearch-checkpoint.mjs read <checkpoint> | write <checkpoint> <expected-sha256|new> <input.json>',
  )
  const path = resolve(file)
  const result =
    command === 'read'
      ? await readCheckpoint(path)
      : await writeCheckpoint(path, expected, JSON.parse(await readFile(input, 'utf8')))
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main(process.argv.slice(2))

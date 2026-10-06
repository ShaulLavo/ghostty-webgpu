import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCheckpoint, writeCheckpoint } from './autoresearch-checkpoint.mjs'

test('checkpoint preserves rejection history, resumes next action, and rejects stale writers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ghostty-autoresearch-'))
  const path = join(root, 'checkpoint.json')
  const initial = {
    mode: 'dry-run',
    phase: 'screen',
    nextAction: 'Evaluate the original smoke result',
    references: ['existing research checkpoint', 'registered protocol'],
    budget: {
      maxExperiments: 1,
      completedExperiments: 0,
      maxMinutes: 10,
      startedAt: new Date().toISOString(),
    },
    experiment: { id: 'smoke-1', benchmark: 'original.json' },
  }
  try {
    assert.equal((await readCheckpoint(path)).sha256, 'new')
    const first = await writeCheckpoint(path, 'new', initial)
    const rejected = {
      ...initial,
      phase: 'reject',
      nextAction: 'Select the retained row-view candidate',
      experiment: { ...initial.experiment, outcome: 'REJECT', reason: 'Performance unqualified' },
    }
    const second = await writeCheckpoint(path, first.sha256, rejected)
    await assert.rejects(writeCheckpoint(path, first.sha256, initial), /Checkpoint changed/)
    assert.deepEqual(await readCheckpoint(path), second)
    await assert.rejects(
      writeCheckpoint(path, second.sha256, { ...rejected, mode: 'research' }),
      /new run mode/,
    )
    await assert.rejects(
      writeCheckpoint(path, second.sha256, {
        ...rejected,
        budget: { ...initial.budget, maxMinutes: 20 },
      }),
      /Run budget is fixed/,
    )
    await assert.rejects(
      writeCheckpoint(path, second.sha256, {
        ...rejected,
        phase: 'keep',
        experiment: { ...rejected.experiment, outcome: 'KEEP' },
      }),
      /immutable/,
    )
    const next = {
      ...rejected,
      phase: 'select',
      experiment: null,
      budget: { ...initial.budget, completedExperiments: 1 },
    }
    const third = await writeCheckpoint(path, second.sha256, next)
    await assert.rejects(writeCheckpoint(path, third.sha256, rejected), /Budget count decreased/)
    await assert.rejects(
      writeCheckpoint(path, third.sha256, {
        ...next,
        phase: 'screen',
        experiment: rejected.experiment,
      }),
      /cannot restart/,
    )
    assert.deepEqual(
      JSON.parse(await readFile(`${path}.history/${first.sha256}.json`, 'utf8')),
      initial,
    )
    assert.deepEqual(
      JSON.parse(await readFile(`${path}.history/${second.sha256}.json`, 'utf8')),
      rejected,
    )
    await assert.rejects(
      writeCheckpoint(path, second.sha256, { ...rejected, phase: 'unknown' }),
      /Unknown/,
    )
    assert.equal(
      (await readdir(root)).some((name) => name.endsWith('.tmp') || name.endsWith('.lock')),
      false,
    )
    await writeFile(`${path}.history/${first.sha256}.json`, '{}')
    await assert.rejects(writeCheckpoint(path, third.sha256, next), /History digest changed/)
    await mkdir(`${path}.lock`)
    await assert.rejects(writeCheckpoint(path, third.sha256, initial), { code: 'EEXIST' })
    assert.deepEqual(await readCheckpoint(path), third)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('corrupt checkpoint remains a failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ghostty-autoresearch-'))
  const path = join(root, 'checkpoint.json')
  try {
    await writeFile(path, '{')
    await assert.rejects(readCheckpoint(path), SyntaxError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('interruption before promotion leaves intent uncommitted; promoted decisions stay frozen without a snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ghostty-autoresearch-'))
  const path = join(root, 'checkpoint.json')
  const initial = {
    mode: 'dry-run',
    phase: 'screen',
    nextAction: 'Read original output',
    references: ['authority'],
    budget: {
      maxExperiments: 1,
      completedExperiments: 0,
      maxMinutes: 10,
      startedAt: new Date().toISOString(),
    },
    experiment: { id: 'interrupted' },
  }
  try {
    const current = await writeCheckpoint(path, 'new', initial)
    const rejected = {
      ...initial,
      phase: 'reject',
      experiment: { id: 'interrupted', outcome: 'REJECT' },
    }
    await writeFile(`${path}.orphan.tmp`, JSON.stringify(rejected))
    const resumed = await writeCheckpoint(path, current.sha256, {
      ...initial,
      nextAction: 'Recover live job',
    })
    const terminal = await writeCheckpoint(path, resumed.sha256, rejected)
    await rm(`${path}.history/${terminal.sha256}.json`)
    await assert.rejects(writeCheckpoint(path, terminal.sha256, initial), /immutable/)
    const next = { ...rejected, phase: 'select', experiment: null }
    await writeCheckpoint(path, terminal.sha256, next)
    assert.deepEqual(
      JSON.parse(await readFile(`${path}.history/${terminal.sha256}.json`, 'utf8')),
      rejected,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import type { NativeInputs } from './contract'
import { verifyOwnedFilesAtHead } from './inputs'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test.each(['.', 'ghostty-webgpu'])('checks committed native inputs inside %s', (prefix) => {
  const checkout = mkdtempSync(join(tmpdir(), 'ghostty-native-inputs-'))
  roots.push(checkout)
  const family = join(checkout, prefix)
  mkdirSync(family, { recursive: true })
  const bytes = Buffer.from('{"name":"native-input-fixture"}\n')
  writeFileSync(join(family, 'package.json'), bytes)
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: checkout, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    return result.stdout.trim()
  }
  git(['init', '-q'])
  git(['add', '.'])
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-qm',
    'Fixture',
  ])
  const head = git(['rev-parse', 'HEAD'])
  const inputs: NativeInputs = JSON.parse(
    readFileSync(new URL('./native-inputs.json', import.meta.url), 'utf8'),
  )
  const fixtureInputs: NativeInputs = {
    ...inputs,
    ownedFiles: [
      {
        path: 'package.json',
        mode: '100644',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    ],
  }
  expect(() => verifyOwnedFilesAtHead(family, fixtureInputs, head)).not.toThrow()
})

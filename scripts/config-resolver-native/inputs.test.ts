import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import type { NativeInputs } from './contract'
import { createNativeInputs, discoverOwnedPaths, verifyOwnedFilesAtHead } from './inputs'
import { renderWorkspaceNativeWorkflow } from './workflow'

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

test('native inputs reject changes to the active workspace workflow', () => {
  const source = resolve(import.meta.dirname, '../..')
  const checkout = mkdtempSync(join(tmpdir(), 'ghostty-native-workflow-'))
  roots.push(checkout)
  const family = join(checkout, 'ghostty-webgpu')
  for (const file of discoverOwnedPaths(source)) {
    const destination = join(family, file)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(join(source, file), destination)
  }
  writeFileSync(join(checkout, 'package.json'), JSON.stringify({ workspaces: ['ghostty-webgpu'] }))
  const workflow = join(checkout, '.github/workflows/ghostty-config-resolver.yml')
  mkdirSync(dirname(workflow), { recursive: true })
  writeFileSync(
    workflow,
    renderWorkspaceNativeWorkflow(
      readFileSync(join(source, '.github/workflows/config-resolver.yml'), 'utf8'),
    ),
  )
  const originalInputs = createNativeInputs(family)

  const original = readFileSync(workflow, 'utf8')
  writeFileSync(workflow, original.replace('BUN_VERSION: 1.4.2', 'BUN_VERSION: 1.4.3'))
  expect(() => createNativeInputs(family)).toThrow(/native workflow/)

  const canonical = join(family, '.github/workflows/config-resolver.yml')
  const updated = readFileSync(canonical, 'utf8').replace(
    'BUN_VERSION: 1.4.2',
    'BUN_VERSION: 1.4.3',
  )
  writeFileSync(canonical, updated)
  writeFileSync(workflow, renderWorkspaceNativeWorkflow(updated))
  expect(createNativeInputs(family)).not.toEqual(originalInputs)
})

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { GHOSTTY_SOURCE_REVISION } from '../src/core/version.js'

let source: string | undefined

afterEach(() => {
  if (source) rmSync(source, { recursive: true, force: true })
  source = undefined
})

function git(args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd: source, encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout.trim()
}

function checkout(): string {
  source = mkdtempSync(join(tmpdir(), 'ghostty-source-test-'))
  git(['init', '-q'])
  writeFileSync(join(source, 'input.h'), 'pinned input\n')
  git(['add', 'input.h'])
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-qm',
    'Fixture',
  ])
  return source
}

function checkClean(path: string) {
  const script = join(import.meta.dirname, 'ghostty-source.ts')
  return spawnSync(
    'bun',
    [
      '--eval',
      `import { verifyCleanSource } from ${JSON.stringify(script)}; await verifyCleanSource(${JSON.stringify(path)})`,
    ],
    { encoding: 'utf8' },
  )
}

it('rejects an unpinned bridge source before invoking Zig', () => {
  const path = checkout()
  const revision = git(['rev-parse', 'HEAD'])
  const result = spawnSync(
    'bun',
    [join(import.meta.dirname, 'build-bridge.ts'), '--source', path, '--zig', 'zig-must-not-run'],
    { encoding: 'utf8' },
  )
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain(
    `Expected Ghostty ${GHOSTTY_SOURCE_REVISION}, received ${revision}`,
  )
  expect(result.stderr).not.toContain('zig-must-not-run')
})

it('validates and compiles the same relative bridge source from an external cwd', () => {
  source = mkdtempSync(join(tmpdir(), 'ghostty-source-test-'))
  const path = join(source, 'ghostty')
  const bin = join(source, 'bin')
  const calls = join(source, 'calls.jsonl')
  mkdirSync(join(path, 'include'), { recursive: true })
  mkdirSync(bin)
  const record = `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');`
  writeFileSync(
    join(bin, 'git'),
    `#!/usr/bin/env bun
${record}
if (process.argv[2] === 'rev-parse') console.log(${JSON.stringify(GHOSTTY_SOURCE_REVISION)});
`,
    { mode: 0o755 },
  )
  writeFileSync(join(bin, 'zig'), `#!/usr/bin/env bun\n${record}\nprocess.exit(1);\n`, {
    mode: 0o755,
  })
  const result = spawnSync(
    'bun',
    [join(import.meta.dirname, 'build-bridge.ts'), '--source', 'ghostty'],
    { cwd: source, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' },
  )
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('zig exited with status 1')
  const invocations: { cwd: string; args: string[] }[] = readFileSync(calls, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(invocations).toHaveLength(3)
  expect(invocations[0]).toEqual({ cwd: path, args: ['rev-parse', 'HEAD'] })
  expect(invocations[1]).toEqual({
    cwd: path,
    args: ['status', '--porcelain=v1', '--untracked-files=all'],
  })
  const compilation = invocations[2]!
  expect(compilation.cwd).toBe(join(import.meta.dirname, '..'))
  expect(compilation.args[compilation.args.indexOf('-I') + 1]).toBe(join(path, 'include'))
})

it('accepts a clean source tree', () => {
  const result = checkClean(checkout())
  expect(result.status, result.stderr).toBe(0)
})

it.each(['tracked', 'staged', 'untracked'])('rejects %s changes to source inputs', (kind) => {
  const path = checkout()
  writeFileSync(join(path, kind === 'untracked' ? 'extra.h' : 'input.h'), 'changed input\n')
  if (kind === 'staged') git(['add', 'input.h'])
  const result = checkClean(path)
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('Ghostty source tree must be clean to build pinned artifacts')
})

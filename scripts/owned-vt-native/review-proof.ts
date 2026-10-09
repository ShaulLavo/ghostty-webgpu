import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ArtifactBuildError } from '../ghostty-source.js'
import { editorIdentity, output } from './identity.js'
import { Native, type Receipt } from './native.js'
import { viewportGuard, type Session } from './proof.js'

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new ArtifactBuildError(`${name} requires a value`)
  return value
}

async function watchdog<T>(task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ArtifactBuildError('Review test watchdog expired')),
          2000,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH')
    return false
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

const check = argument('--check')
const evidenceArgument = argument('--evidence')
if (!check || !evidenceArgument) {
  console.log(
    'SKIP review proof: pass --check transport|overflow|reuse|source and --evidence <new-directory>.',
  )
  process.exit(0)
}
if (process.platform === 'win32' || !Bun.which('sh')) {
  console.log('SKIP review proof: controlled transport fixtures require a POSIX shell.')
  process.exit(0)
}
const binary = argument('--binary')
const editor = argument('--editor-source')
const source = argument('--source')
if (['overflow', 'reuse'].includes(check) && (!binary || !editor)) {
  console.log('SKIP review proof: native checks require --binary and --editor-source.')
  process.exit(0)
}
if (check === 'reuse' && !source) {
  console.log('SKIP review proof: reuse checks require --source.')
  process.exit(0)
}
const tools = check === 'transport' ? [] : ['git']
if (check === 'reuse') tools.push('zig')
if (tools.some((tool) => !Bun.which(tool, { PATH: process.env['PATH'] ?? '' }))) {
  console.log('SKIP review proof: required Git/compiler executable is unavailable.')
  process.exit(0)
}
const evidence = resolve(evidenceArgument)
await mkdir(evidence)
const workspace = await mkdtemp(
  join(resolve(argument('--scratch') ?? tmpdir()), 'owned-vt-review-'),
)
const directory = dirname(fileURLToPath(import.meta.url))
const records: Record<string, unknown>[] = []
const receipt: Receipt = (value) => records.push(value)
let failures = 0

async function test(name: string, operation: () => Promise<void>): Promise<void> {
  try {
    await operation()
    receipt({ kind: 'case', case: name, outcome: 'PASS' })
    console.log(`PASS ${name}`)
  } catch (error) {
    failures++
    receipt({ kind: 'case', case: name, outcome: 'FAIL', error: String(error) })
    console.log(`FAIL ${name}: ${String(error)}`)
  }
}

async function transport(ack: boolean): Promise<void> {
  const name = ack ? 'shutdown-deadline' : 'silent-ack-deadline'
  const pidFile = join(workspace, `${name}.pid`)
  const fixture = join(workspace, `${name}.sh`)
  await writeFile(
    fixture,
    `#!/bin/sh\nprintf '%s\\n' "$$" > ${quote(pidFile)}\ntrap '' TERM\nwhile IFS= read -r command; do\n${ack ? '  printf \'{"ok":true}\\n\'' : '  :'}\ndone\nkill -STOP "$$"\n`,
    { mode: 0o755 },
  )
  const native = new Native(fixture, name, receipt, {
    acknowledgement: 100,
    shutdown: 100,
    forcedShutdown: 100,
    drain: 100,
  })
  try {
    const pattern = ack ? /shutdown deadline/ : /acknowledgement deadline/
    if (ack) await watchdog(native.create(4, 2))
    const pending = ack ? native.close() : native.create(4, 2)
    await assert.rejects(watchdog(pending), pattern)
    const pid = Number((await readFile(pidFile, 'utf8')).trim())
    assert.equal(alive(pid), false, 'transport must reap its child before rejecting')
    await assert.rejects(watchdog(native.snapshot()), pattern)
    await assert.rejects(watchdog(native.close()), pattern)
    receipt({ kind: 'transport-observation', case: name, pid, reapedBeforeHarnessCleanup: true })
  } finally {
    const pid = Number((await readFile(pidFile, 'utf8')).trim())
    assert.ok(Number.isInteger(pid) && pid > 1 && pid !== process.pid)
    const harnessKill = alive(pid)
    if (harnessKill) process.kill(pid, 'SIGKILL')
    await watchdog(native.close()).catch((error) =>
      receipt({ kind: 'cleanup', case: name, error: String(error) }),
    )
    receipt({ kind: 'fixture-cleanup', case: name, pid, harnessKill, alive: alive(pid) })
  }
}

async function overflow(): Promise<void> {
  receipt({
    kind: 'editor-input',
    ...(await editorIdentity(resolve(editor!), '8cdc43dbf013e0f826e8413893b7c529edfc54e2')),
  })
  const { ReadSession } = await import(pathToFileURL(join(resolve(editor!), 'src/session.ts')).href)
  const mutants: {
    name: string
    corrupt: (session: Session, native: Native) => Promise<void>
    pattern: RegExp
  }[] = [
    {
      name: 'cleared-text',
      corrupt: (session) => session.dispatch({ kind: 'interrupt' }),
      pattern: /retained text/,
    },
    {
      name: 'wrong-logical-cursor',
      corrupt: (session) => session.dispatch({ kind: 'left' }),
      pattern: /retained cursor/,
    },
    {
      name: 'wrong-native-cursor',
      corrupt: async (_, native) => {
        await native.write('\r')
      },
      pattern: /native cursor/,
    },
  ]
  for (const mutant of mutants) {
    await test(`overflow-rejects-${mutant.name}`, async () => {
      await assert.rejects(
        viewportGuard(
          resolve(binary!),
          new ReadSession(),
          false,
          (value) => receipt({ mutant: mutant.name, ...value }),
          mutant.corrupt,
        ),
        mutant.pattern,
      )
    })
  }
}

async function sourceGuards(): Promise<void> {
  const repo = join(workspace, 'source-fixture')
  const pkg = join(repo, 'pkg')
  await mkdir(join(pkg, 'src'), { recursive: true })
  for (const file of ['session.ts', 'model.ts', 'history.ts', 'keymap.ts', 'structured-errors.ts'])
    await writeFile(join(pkg, 'src', file), 'fixture\n')
  await output(['git', 'init', '--initial-branch=fixture', repo])
  const git = (args: string[]) =>
    output(
      [
        'git',
        '-c',
        'user.name=Proof',
        '-c',
        'user.email=proof@example.invalid',
        '-c',
        'commit.gpgsign=false',
      ].concat(args),
      repo,
    )
  const commit = async () => {
    await git(['add', '.'])
    await git([
      'commit',
      '--no-verify',
      '-m',
      'Proof fixture\n\nCo-Authored-By: Claude Code <noreply@anthropic.com>',
    ])
  }
  await commit()
  const checkpoint = await git(['rev-parse', 'HEAD'])
  await writeFile(join(repo, 'root.txt'), 'unrelated root change\n')
  await commit()
  await test('same-subtree-new-root-head', async () => {
    const identity = await editorIdentity(pkg, checkpoint)
    assert.notEqual(identity.editorCheckout, checkpoint)
    assert.equal(identity.editorTree, identity.editorCheckpointTree)
    receipt({ kind: 'source-input-observation', ...identity })
  })
  const model = join(pkg, 'src/model.ts')
  await writeFile(model, 'dirty\n')
  await test('dirty-tracked-package-rejected', async () => {
    await assert.rejects(editorIdentity(pkg, checkpoint), /must be clean/)
  })
  await writeFile(model, 'fixture\n')
  const untracked = join(pkg, 'untracked.txt')
  await writeFile(untracked, 'dirty\n')
  await test('dirty-untracked-package-rejected', async () => {
    await assert.rejects(editorIdentity(pkg, checkpoint), /must be clean/)
  })
  await rm(untracked)
  await writeFile(model, 'different package\n')
  await commit()
  await test('mismatched-package-subtree-rejected', async () => {
    await assert.rejects(editorIdentity(pkg, checkpoint), /subtree must match/)
  })
  const missing = join(repo, 'missing')
  await mkdir(missing)
  await test('missing-package-subtree-rejected', async () => {
    await assert.rejects(editorIdentity(missing, checkpoint), /identity command failed/)
  })
}

async function reuse(removeIdentity: boolean): Promise<void> {
  const name = removeIdentity ? 'missing-build-identity' : 'mismatched-build-identity'
  const previous = dirname(resolve(binary!))
  const mutated = join(workspace, name)
  await mkdir(mutated)
  for (const file of ['owned-vt-terminal', 'records.jsonl', 'records.sha256'])
    await copyFile(join(previous, file), join(mutated, file))
  const metadata = JSON.parse(await readFile(join(previous, 'sources.json'), 'utf8'))
  if (removeIdentity) delete metadata.buildIdentity
  if (!removeIdentity)
    metadata.buildIdentity = { ...metadata.buildIdentity, target: { triple: 'unqualified-target' } }
  await writeFile(join(mutated, 'sources.json'), `${JSON.stringify(metadata, null, 2)}\n`)
  const child = Bun.spawn(
    [
      process.execPath,
      join(directory, 'run.ts'),
      '--source',
      resolve(source!),
      '--editor-source',
      resolve(editor!),
      '--binary',
      join(mutated, 'owned-vt-terminal'),
      '--scratch',
      workspace,
      '--evidence',
      join(evidence, name),
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  const code = await child.exited
  const output = await stdout
  const error = await stderr
  await writeFile(join(evidence, `${name}.stdout`), output)
  await writeFile(join(evidence, `${name}.stderr`), error)
  receipt({ kind: 'reuse-observation', case: name, code, stdout: output, stderr: error })
  assert.notEqual(code, 0, 'unqualified build identity must be rejected')
  assert.match(error, /build identity/)
  assert.doesNotMatch(output, /PASS ascii-midline/, 'identity rejection precedes native admission')
}

try {
  if (check === 'transport') {
    await test('silent-ack-deadline', () => transport(false))
    await test('shutdown-deadline', () => transport(true))
  }
  if (check === 'overflow') await overflow()
  if (check === 'reuse') {
    await test('missing-build-identity', () => reuse(true))
    await test('mismatched-build-identity', () => reuse(false))
  }
  if (check === 'source') await sourceGuards()
  assert.ok(
    ['transport', 'overflow', 'reuse', 'source'].includes(check),
    'known review check required',
  )
} finally {
  const content = `${records.map((value) => JSON.stringify(value)).join('\n')}\n`
  await writeFile(join(evidence, 'records.jsonl'), content)
  await writeFile(
    join(evidence, 'records.sha256'),
    `${createHash('sha256').update(content).digest('hex')}  records.jsonl\n`,
  )
  await copyFile(fileURLToPath(import.meta.url), join(evidence, 'review-proof.ts'))
  await copyFile(join(directory, 'native.ts'), join(evidence, 'native.ts'))
  await copyFile(join(directory, 'proof.ts'), join(evidence, 'proof.ts'))
  await copyFile(join(directory, 'run.ts'), join(evidence, 'run.ts'))
  await copyFile(join(directory, 'identity.ts'), join(evidence, 'identity.ts'))
  await rm(workspace, { recursive: true, force: true })
}
assert.equal(failures, 0, 'review proof has failing checks')

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { arch, platform, release } from 'node:os'
import { join } from 'node:path'
import { ArtifactBuildError } from '../ghostty-source.js'

export async function output(command: string[], cwd?: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  const code = await child.exited
  const result = await stdout
  const error = await stderr
  if (code) throw new ArtifactBuildError(`Proof identity command failed (${code}): ${error}`)
  return result.trim()
}

export function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export async function hash(path: string): Promise<string> {
  return digest(await readFile(path))
}

function field(zon: string, name: string): string {
  const match = zon.match(new RegExp(`^    \\.${name} = ("(?:[^"\\\\]|\\\\.)*"),$`, 'm'))
  assert.ok(match, `compiler must report ${name}`)
  return JSON.parse(match[1]!) as string
}

export async function buildIdentity(source: string, zig: string, hashes: Record<string, string>) {
  const env = await output([zig, 'env'])
  const executable = await realpath(field(env, 'zig_exe'))
  const version = await output([executable, 'version'])
  assert.equal(version, field(env, 'version'), 'compiler executable must match reported version')
  assert.equal(version, '0.16.0', 'qualified proof requires Zig 0.16.0')
  const targets = await output([executable, 'targets'])
  const start = targets.lastIndexOf('\n    .native = .{')
  assert.ok(start >= 0 && targets.endsWith('\n}'), 'compiler must report native target identity')
  const native = targets.slice(start + 1, -2).trim()
  return {
    schema: 1,
    upstream: {
      revision: await output(['git', 'rev-parse', 'HEAD'], source),
      tree: await output(['git', 'rev-parse', 'HEAD^{tree}'], source),
    },
    compiler: { executable, sha256: await hash(executable), version },
    host: { platform: platform(), architecture: arch(), release: release() },
    target: { triple: field(env, 'target'), nativeZon: native, nativeSha256: digest(native) },
    configuration: {
      target: 'native',
      cpu: 'native',
      optimize: 'Debug',
      simd: false,
      linkLibc: true,
    },
    recipe: {
      buildZig: hashes['build.zig'],
      terminalC: hashes['terminal.c'],
      upstreamBuildZig: await hash(join(source, 'build.zig')),
      upstreamBuildZon: await hash(join(source, 'build.zig.zon')),
      cFlags: ['-std=c11', '-Wall', '-Wextra', '-Werror'],
      arguments: [
        'build',
        '--summary',
        'all',
        '--system',
        '<extracted-package-cache>',
        '-Dtarget=native',
        '-Dcpu=native',
        '-Doptimize=Debug',
      ],
    },
  }
}
export type BuildIdentity = Awaited<ReturnType<typeof buildIdentity>>
export interface BuildReceipt {
  kind: 'build'
  code: number
  identity: BuildIdentity
  argv: string[]
  cwd: string
  manifest: { content: string; sha256: string }
  library: { file: string; sha256: string }
}

export interface EditorIdentity {
  editorPin: string
  editorCheckout: string
  editorCheckpointTree: string
  editorTree: string
  editorHashes: Record<string, string>
}

export async function editorIdentity(editor: string, editorPin: string): Promise<EditorIdentity> {
  const editorCheckout = await output(['git', 'rev-parse', 'HEAD'], editor)
  const prefix = (await output(['git', 'rev-parse', '--show-prefix'], editor)).replace(/\/$/, '')
  const editorTree = await output(['git', 'rev-parse', `HEAD:${prefix}`], editor)
  const editorCheckpointTree = await output(['git', 'rev-parse', `${editorPin}:${prefix}`], editor)
  if (editorTree !== editorCheckpointTree)
    throw new ArtifactBuildError('ReadSession checkpoint package subtree must match')
  if (await output(['git', 'status', '--porcelain=v1', '--untracked-files=all', '--', '.'], editor))
    throw new ArtifactBuildError('ReadSession checkpoint package must be clean')
  const editorHashes = Object.fromEntries(
    await Promise.all(
      ['session.ts', 'model.ts', 'history.ts', 'keymap.ts', 'structured-errors.ts'].map(
        async (file) => [file, await hash(join(editor, 'src', file))],
      ),
    ),
  )
  return { editorPin, editorCheckout, editorCheckpointTree, editorTree, editorHashes }
}

export async function qualifiedBuild(
  previous: string,
  identity: BuildIdentity,
  editor: EditorIdentity,
): Promise<BuildReceipt> {
  const directory = join(previous, '..')
  const metadata = JSON.parse(await readFile(join(directory, 'sources.json'), 'utf8'))
  const content = await readFile(join(directory, 'records.jsonl'), 'utf8')
  const checksum = (await readFile(join(directory, 'records.sha256'), 'utf8')).trim()
  const records = content
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const binary = records.find((value) => value.kind === 'binary')
  const build = binary?.build as BuildReceipt | undefined
  try {
    assert.equal(checksum, `${digest(content)}  records.jsonl`)
    assert.ok(metadata.buildIdentity && build, 'qualified build identity is required')
    assert.deepEqual(metadata.buildIdentity, identity)
    assert.deepEqual(build.identity, identity)
    assert.equal(metadata.editorPin, editor.editorPin)
    assert.equal(metadata.editorCheckpointTree, editor.editorCheckpointTree)
    assert.equal(metadata.editorTree, editor.editorTree)
    assert.deepEqual(metadata.editorHashes, editor.editorHashes)
    assert.match(metadata.editorCheckout, /^[a-f0-9]{40}$/)
    assert.equal(build.kind, 'build')
    assert.equal(build.code, 0)
    assert.equal(build.argv[0], identity.compiler.executable)
    assert.equal(build.argv.length, 9)
    assert.deepEqual(build.argv.slice(1, 5), ['build', '--summary', 'all', '--system'])
    assert.deepEqual(build.argv.slice(-3), ['-Dtarget=native', '-Dcpu=native', '-Doptimize=Debug'])
    assert.equal(build.manifest.sha256, digest(build.manifest.content))
    assert.equal(build.library.file, 'ghostty-vt-static.a')
    assert.equal(build.library.sha256, await hash(join(directory, build.library.file)))
    assert.equal(binary.sha256, await hash(previous))
  } catch (error) {
    throw new ArtifactBuildError(
      `Reused native binary requires matching qualified build identity: ${String(error)}`,
    )
  }
  return build!
}

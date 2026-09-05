import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { NativeResolverManifest } from '../config-resolver-native/contract'
import {
  NATIVE_BOOTSTRAP_PATH,
  NATIVE_MANIFEST_PATH,
  NATIVE_TARGETS,
} from '../config-resolver-native/constants'
import { ReleaseCandidateError, validateCanonicalSemver, validateHead } from './validation'

const MAX_COMMAND_OUTPUT = 16 * 1024 * 1024
const VERIFIER_DEPENDENCIES = [
  'scripts/create-release-candidate.ts',
  'scripts/config-resolver-native/canonical.ts',
  'scripts/config-resolver-native/constants.ts',
  'scripts/config-resolver-native/contract.ts',
  'scripts/config-resolver-native/link-plan.ts',
  'scripts/config-resolver-native/order.ts',
  'src/config-resolver/canonicalize.ts',
] as const

export type CommandResult = {
  readonly status: number
  readonly stdout: Buffer
  readonly stderr: Buffer
}

export type CommandRunner = (
  command: string,
  arguments_: readonly string[],
  cwd: string,
) => CommandResult

export const runCommand: CommandRunner = (command, arguments_, cwd) => {
  const result = spawnSync(command, [...arguments_], {
    cwd,
    env: releaseCommandEnvironment(),
    encoding: 'buffer',
    maxBuffer: MAX_COMMAND_OUTPUT,
    shell: false,
  })
  if (result.error) throw new ReleaseCandidateError('release command could not be executed')
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0),
  }
}

export function requireCleanCommittedCheckout(root: string, runner = runCommand): string {
  const head = commandText(runner, 'git', ['rev-parse', '--verify', 'HEAD'], root, 'Git HEAD')
  validateHead(head, 'package source HEAD')
  const status = runner('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], root)
  if (status.status !== 0 || status.stderr.length !== 0 || status.stdout.length !== 0) {
    throw new ReleaseCandidateError('release source checkout is not clean')
  }
  return head
}

export function requireVerifierAtHead(
  root: string,
  expectedHead: string,
  runner = runCommand,
): void {
  const actualHead = requireCleanCommittedCheckout(root, runner)
  if (actualHead !== expectedHead) {
    throw new ReleaseCandidateError('release verifier checkout differs from packageSourceHead')
  }
  const files = commandBuffer(
    runner,
    'git',
    [
      'ls-tree',
      '-r',
      '--name-only',
      '-z',
      expectedHead,
      '--',
      'scripts/release-candidate',
      ...VERIFIER_DEPENDENCIES,
    ],
    root,
    'release verifier file list',
  )
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
  for (const path of VERIFIER_DEPENDENCIES) requireListedFile(files, path)
  const releaseFiles = collectReleaseFiles(root)
  const committedReleaseFiles = files.filter((path) =>
    path.startsWith('scripts/release-candidate/'),
  )
  if (JSON.stringify(releaseFiles) !== JSON.stringify(committedReleaseFiles)) {
    throw new ReleaseCandidateError('release verifier closure has uncommitted or missing files')
  }
  for (const path of files) verifyGitObjectFile(root, expectedHead, path, runner)
}

export function releaseToolVersions(
  root: string,
  runner = runCommand,
): {
  readonly bun: string
  readonly node: string
  readonly npm: string
} {
  const bun = commandText(runner, 'bun', ['--version'], root, 'Bun version')
  const rawNode = commandText(runner, 'node', ['--version'], root, 'Node version')
  const npm = commandText(runner, 'npm', ['--version'], root, 'npm version')
  const node = rawNode.startsWith('v') ? rawNode.slice(1) : rawNode
  return {
    bun: validateCanonicalSemver(bun, 'Bun version'),
    node: validateCanonicalSemver(node, 'Node version'),
    npm: validateCanonicalSemver(npm, 'npm version'),
  }
}

export function releaseRuntimeVersions(
  root: string,
  runner = runCommand,
): { readonly bun: string; readonly node: string } {
  const bun = commandText(runner, 'bun', ['--version'], root, 'Bun version')
  const rawNode = commandText(runner, 'node', ['--version'], root, 'Node version')
  const node = rawNode.startsWith('v') ? rawNode.slice(1) : rawNode
  return {
    bun: validateCanonicalSemver(bun, 'Bun version'),
    node: validateCanonicalSemver(node, 'Node version'),
  }
}

export function requireGeneratedOnlyPackageDiff(
  root: string,
  packageSourceHead: string,
  manifest: NativeResolverManifest,
  runner = runCommand,
): void {
  validateHead(packageSourceHead, 'package source HEAD')
  validateHead(manifest.nativeBuildSourceHead, 'native build source HEAD')
  const ancestor = runner(
    'git',
    ['merge-base', '--is-ancestor', manifest.nativeBuildSourceHead, packageSourceHead],
    root,
  )
  if (ancestor.status !== 0 || ancestor.stdout.length !== 0 || ancestor.stderr.length !== 0) {
    throw new ReleaseCandidateError('native build source is not an ancestor of package source')
  }
  const output = commandBuffer(
    runner,
    'git',
    [
      'diff',
      '--name-status',
      '-z',
      '--no-renames',
      manifest.nativeBuildSourceHead,
      packageSourceHead,
    ],
    root,
    'native generated-only package diff',
  )
  const actual = parseNameStatus(output)
  const expected = expectedGeneratedDiff(manifest)
  if (actual.size !== expected.size) {
    throw new ReleaseCandidateError('package source contains a non-generated native diff')
  }
  for (const [path, status] of expected) {
    if (actual.get(path) !== status) {
      throw new ReleaseCandidateError('package source contains a non-generated native diff')
    }
  }
}

function expectedGeneratedDiff(manifest: NativeResolverManifest): ReadonlyMap<string, 'A' | 'D'> {
  const expected = new Map<string, 'A' | 'D'>([
    [NATIVE_BOOTSTRAP_PATH, 'D'],
    [NATIVE_MANIFEST_PATH, 'A'],
  ])
  for (const target of NATIVE_TARGETS) {
    for (const file of manifest.targets[target].files) {
      expected.set(`native/config-resolver/${target}/${file.path}`, 'A')
    }
  }
  return expected
}

function parseNameStatus(bytes: Buffer): ReadonlyMap<string, 'A' | 'D'> {
  let source: string
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new ReleaseCandidateError('native generated-only diff is not valid UTF-8')
  }
  const fields = source.split('\0')
  if (fields.at(-1) !== '') {
    throw new ReleaseCandidateError('native generated-only diff is not NUL terminated')
  }
  fields.pop()
  if (fields.length % 2 !== 0) {
    throw new ReleaseCandidateError('native generated-only diff has an invalid record')
  }
  const result = new Map<string, 'A' | 'D'>()
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index]
    const path = fields[index + 1]
    if ((status !== 'A' && status !== 'D') || !path || result.has(path)) {
      throw new ReleaseCandidateError('native generated-only diff has an invalid record')
    }
    result.set(path, status)
  }
  return result
}

function verifyGitObjectFile(
  root: string,
  head: string,
  path: string,
  runner: CommandRunner,
): void {
  const relativePath = relative(root, `${root}${sep}${path.split('/').join(sep)}`)
  if (relativePath.startsWith('..') || relativePath === '') {
    throw new ReleaseCandidateError('release verifier path escapes its checkout')
  }
  let worktree: Buffer
  try {
    worktree = readFileSync(`${root}${sep}${relativePath}`)
  } catch {
    throw new ReleaseCandidateError('release verifier file is missing from its checkout')
  }
  const committed = commandBuffer(
    runner,
    'git',
    ['show', `${head}:${path}`],
    root,
    'release verifier Git object',
  )
  if (!worktree.equals(committed)) {
    throw new ReleaseCandidateError('release verifier differs from its committed Git object')
  }
}

function collectReleaseFiles(root: string): readonly string[] {
  const prefix = 'scripts/release-candidate'
  const pending = [prefix]
  const files: string[] = []
  while (pending.length > 0) {
    const directory = pending.pop()
    if (!directory) continue
    const entries = readdirSync(join(root, ...directory.split('/')), { withFileTypes: true })
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) {
        pending.push(path)
        continue
      }
      if (!entry.isFile()) {
        throw new ReleaseCandidateError('release verifier closure contains a special file')
      }
      files.push(path)
    }
  }
  return files.sort()
}

function requireListedFile(files: readonly string[], path: string): void {
  if (!files.includes(path)) {
    throw new ReleaseCandidateError('release verifier closure is absent from packageSourceHead')
  }
}

function commandText(
  runner: CommandRunner,
  command: string,
  arguments_: readonly string[],
  cwd: string,
  label: string,
): string {
  const output = commandBuffer(runner, command, arguments_, cwd, label)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(output).trim()
  } catch {
    throw new ReleaseCandidateError(`${label} is not valid UTF-8`)
  }
  if (!text || text.includes('\r') || text.includes('\n') || text.includes('\0')) {
    throw new ReleaseCandidateError(`${label} is invalid`)
  }
  return text
}

function commandBuffer(
  runner: CommandRunner,
  command: string,
  arguments_: readonly string[],
  cwd: string,
  label: string,
): Buffer {
  const result = runner(command, arguments_, cwd)
  if (result.status !== 0 || result.stderr.length !== 0) {
    throw new ReleaseCandidateError(`${label} command failed`)
  }
  if (result.stdout.length > MAX_COMMAND_OUTPUT) {
    throw new ReleaseCandidateError(`${label} exceeds its output bound`)
  }
  return result.stdout
}

function releaseCommandEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const name of ['HOME', 'PATH', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot']) {
    const value = process.env[name]
    if (value !== undefined) environment[name] = value
  }
  environment.CI = 'true'
  environment.NO_COLOR = '1'
  environment.npm_config_audit = 'false'
  environment.npm_config_fund = 'false'
  environment.npm_config_ignore_scripts = 'false'
  environment.npm_config_update_notifier = 'false'
  return environment
}

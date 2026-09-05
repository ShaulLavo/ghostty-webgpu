import { lstatSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assembleNativeArtifacts } from './config-resolver-native/assembly'
import { buildNativeTarget } from './config-resolver-native/builder'
import {
  NativeContractError,
  readStableRegularFile,
  sha256,
} from './config-resolver-native/canonical'
import {
  NATIVE_TARGET_CEILINGS,
  NATIVE_TARGETS,
  type NativeTarget,
} from './config-resolver-native/constants'
import { loadNativeProvenance } from './config-resolver-native/contract'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const MODES = ['assemble', 'build-target', 'compare-builds'] as const
type Mode = (typeof MODES)[number]

try {
  main(process.argv.slice(2))
} catch {
  process.stderr.write('config resolver build failed\n')
  process.exitCode = 1
}

function main(argv: readonly string[]): void {
  const values = parseOptions(argv)
  const mode = exactMode(values.get('--mode'))
  if (mode === 'build-target') {
    runBuildTarget(values)
    return
  }
  if (mode === 'compare-builds') {
    runCompareBuilds(values)
    return
  }
  runAssembly(values)
}

function runBuildTarget(values: ReadonlyMap<string, string>): void {
  assertOptionSet(values, [
    '--mode',
    '--upstream',
    '--zig',
    '--zig-archive',
    '--themes-archive',
    '--target',
    '--output',
    '--run-id',
    '--run-attempt',
    '--expected-head',
    '--bun',
    '--node',
  ])
  const result = buildNativeTarget({
    upstream: existingAbsolute(values, '--upstream', 'directory'),
    zig: existingAbsolute(values, '--zig', 'file'),
    zigArchive: existingAbsolute(values, '--zig-archive', 'file'),
    themesArchive: existingAbsolute(values, '--themes-archive', 'file'),
    target: nativeTarget(required(values, '--target')),
    output: newAbsolute(values, '--output'),
    runId: runId(required(values, '--run-id')),
    runAttempt: runAttempt(required(values, '--run-attempt')),
    expectedHead: revision(required(values, '--expected-head')),
    bun: existingAbsolute(values, '--bun', 'file'),
    node: existingAbsolute(values, '--node', 'file'),
  })
  process.stdout.write(`${result.archiveSha256}\n`)
}

function runCompareBuilds(values: ReadonlyMap<string, string>): void {
  assertOptionSet(values, ['--mode', '--first', '--second', '--target'])
  const target = nativeTarget(required(values, '--target'))
  const first = existingAbsolute(values, '--first', 'directory')
  const second = existingAbsolute(values, '--second', 'directory')
  const archiveName = `ghostty-config-resolver-${target}.tar`
  const maximum = NATIVE_TARGET_CEILINGS[target] + 1_048_576
  const firstArchive = readStableRegularFile(join(first, archiveName), maximum)
  const secondArchive = readStableRegularFile(join(second, archiveName), maximum)
  if (!firstArchive.equals(secondArchive)) {
    throw new NativeContractError('independent native archives differ')
  }
  const firstProvenance = loadNativeProvenance(join(first, 'provenance.json'))
  const secondProvenance = loadNativeProvenance(join(second, 'provenance.json'))
  if (firstProvenance.value.target !== target || secondProvenance.value.target !== target) {
    throw new NativeContractError('independent provenance target differs')
  }
  if (!firstProvenance.bytes.equals(secondProvenance.bytes)) {
    throw new NativeContractError('independent native provenance differs')
  }
  if (firstProvenance.value.archive.sha256 !== sha256(firstArchive)) {
    throw new NativeContractError('independent archive digest differs from provenance')
  }
  process.stdout.write(`${firstProvenance.value.archive.sha256}\n`)
}

function runAssembly(values: ReadonlyMap<string, string>): void {
  assertOptionSet(values, ['--mode', '--run-id', '--run-attempt', '--input'])
  assembleNativeArtifacts(repositoryRoot, {
    input: existingAbsolute(values, '--input', 'directory'),
    runId: runId(required(values, '--run-id')),
    runAttempt: runAttempt(required(values, '--run-attempt')),
  })
  process.stdout.write('assembled\n')
}

function parseOptions(argv: readonly string[]): ReadonlyMap<string, string> {
  if (argv.length === 0 || argv.length % 2 !== 0) {
    throw new NativeContractError('config resolver build arguments are invalid')
  }
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value || values.has(name)) {
      throw new NativeContractError('config resolver build option is invalid')
    }
    values.set(name, value)
  }
  return values
}

function assertOptionSet(values: ReadonlyMap<string, string>, expected: readonly string[]): void {
  const actual = [...values.keys()].sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new NativeContractError('config resolver build option set is invalid')
  }
}

function exactMode(value: string | undefined): Mode {
  if (!value || !MODES.includes(value as Mode)) {
    throw new NativeContractError('config resolver build mode is invalid')
  }
  return value as Mode
}

function nativeTarget(value: string): NativeTarget {
  if (!NATIVE_TARGETS.includes(value as NativeTarget)) {
    throw new NativeContractError('native target is invalid')
  }
  return value as NativeTarget
}

function runId(value: string): string {
  if (!/^[1-9][0-9]{0,19}$/.test(value)) throw new NativeContractError('run ID is invalid')
  return value
}

function runAttempt(value: string): number {
  if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(value)) {
    throw new NativeContractError('run attempt is invalid')
  }
  return Number(value)
}

function revision(value: string): string {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new NativeContractError('source HEAD is invalid')
  return value
}

function required(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name)
  if (!value) throw new NativeContractError(`missing ${name}`)
  return value
}

function existingAbsolute(
  values: ReadonlyMap<string, string>,
  name: string,
  kind: 'directory' | 'file',
): string {
  const path = absolutePath(required(values, name))
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new NativeContractError(`${name} cannot be a symlink`)
  if (kind === 'file' && !stat.isFile()) throw new NativeContractError(`${name} is not a file`)
  if (kind === 'directory' && !stat.isDirectory()) {
    throw new NativeContractError(`${name} is not a directory`)
  }
  return path
}

function newAbsolute(values: ReadonlyMap<string, string>, name: string): string {
  const path = absolutePath(required(values, name))
  if (pathExists(path)) throw new NativeContractError(`${name} already exists`)
  return path
}

function absolutePath(value: string): string {
  if (!isAbsolute(value)) throw new NativeContractError('config resolver path must be absolute')
  return resolve(value)
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

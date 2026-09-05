import { join } from 'node:path'
import {
  finalizeReleaseCandidate,
  packReleaseCandidate,
  verifyReleaseCandidate,
  type FinalizeReleaseCandidateOptions,
  type PackReleaseCandidateOptions,
  type VerifyReleaseCandidateOptions,
} from './core'
import type { CommandRunner } from './repository'
import { ReleaseCandidateError } from './validation'

export type ReleaseCandidateArguments =
  | { readonly mode: 'pack'; readonly options: PackReleaseCandidateOptions }
  | { readonly mode: 'finalize'; readonly options: FinalizeReleaseCandidateOptions }
  | { readonly mode: 'verify'; readonly options: VerifyReleaseCandidateOptions }

export function parseReleaseCandidateArguments(
  argv: readonly string[],
  repositoryRoot: string,
  commandRunner?: CommandRunner,
): ReleaseCandidateArguments {
  const mode = argv[0]
  if (mode !== '--pack' && mode !== '--finalize' && mode !== '--verify') {
    throw new ReleaseCandidateError('exactly one release candidate mode is required')
  }
  const values = optionValues(argv.slice(1))
  if (mode === '--pack') return parsePack(values, repositoryRoot, commandRunner)
  if (mode === '--finalize') return parseFinalize(values, repositoryRoot, commandRunner)
  return parseVerify(values, repositoryRoot, commandRunner)
}

export function runReleaseCandidateArguments(arguments_: ReleaseCandidateArguments): void {
  if (arguments_.mode === 'pack') {
    packReleaseCandidate(arguments_.options)
    return
  }
  if (arguments_.mode === 'finalize') {
    finalizeReleaseCandidate(arguments_.options)
    return
  }
  verifyReleaseCandidate(arguments_.options)
}

function parsePack(
  values: ReadonlyMap<string, readonly string[]>,
  repositoryRoot: string,
  commandRunner?: CommandRunner,
): ReleaseCandidateArguments {
  rejectUnknown(values, ['--run-id', '--run-attempt', '--artifacts-dir'])
  return {
    mode: 'pack',
    options: {
      repositoryRoot,
      artifactsDirectory:
        optionalSingle(values, '--artifacts-dir') ?? join(repositoryRoot, '.artifacts'),
      runId: requiredSingle(values, '--run-id'),
      runAttempt: decimalInteger(requiredSingle(values, '--run-attempt'), '--run-attempt'),
      commandRunner,
    },
  }
}

function parseFinalize(
  values: ReadonlyMap<string, readonly string[]>,
  repositoryRoot: string,
  commandRunner?: CommandRunner,
): ReleaseCandidateArguments {
  rejectUnknown(values, [
    '--run-id',
    '--run-attempt',
    '--tarball',
    '--provisional',
    '--rebuild-provenance',
    '--smoke-provenance',
    '--output-dir',
  ])
  return {
    mode: 'finalize',
    options: {
      repositoryRoot,
      outputDirectory: optionalSingle(values, '--output-dir') ?? join(repositoryRoot, '.artifacts'),
      runId: requiredSingle(values, '--run-id'),
      runAttempt: decimalInteger(requiredSingle(values, '--run-attempt'), '--run-attempt'),
      tarballPath: requiredSingle(values, '--tarball'),
      provisionalPath: requiredSingle(values, '--provisional'),
      rebuildProvenancePaths: requiredRepeated(values, '--rebuild-provenance', 4),
      smokeProvenancePaths: requiredRepeated(values, '--smoke-provenance', 4),
      commandRunner,
    },
  }
}

function parseVerify(
  values: ReadonlyMap<string, readonly string[]>,
  repositoryRoot: string,
  commandRunner?: CommandRunner,
): ReleaseCandidateArguments {
  rejectUnknown(values, ['--tarball', '--identity', '--evidence'])
  return {
    mode: 'verify',
    options: {
      repositoryRoot,
      tarballPath: requiredSingle(values, '--tarball'),
      identityPath: requiredSingle(values, '--identity'),
      evidencePath: requiredSingle(values, '--evidence'),
      commandRunner,
    },
  }
}

function optionValues(argv: readonly string[]): ReadonlyMap<string, readonly string[]> {
  if (argv.length % 2 !== 0) throw new ReleaseCandidateError('release option lacks a value')
  const values = new Map<string, string[]>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value || value.startsWith('--')) {
      throw new ReleaseCandidateError('release option syntax is invalid')
    }
    const existing = values.get(name) ?? []
    existing.push(value)
    values.set(name, existing)
  }
  return values
}

function rejectUnknown(
  values: ReadonlyMap<string, readonly string[]>,
  allowed: readonly string[],
): void {
  for (const name of values.keys()) {
    if (!allowed.includes(name)) throw new ReleaseCandidateError(`unknown release option ${name}`)
  }
}

function requiredSingle(values: ReadonlyMap<string, readonly string[]>, name: string): string {
  const entries = values.get(name)
  if (!entries || entries.length !== 1 || !entries[0]) {
    throw new ReleaseCandidateError(`${name} must occur exactly once`)
  }
  return entries[0]
}

function optionalSingle(
  values: ReadonlyMap<string, readonly string[]>,
  name: string,
): string | undefined {
  const entries = values.get(name)
  if (!entries) return undefined
  if (entries.length !== 1 || !entries[0]) {
    throw new ReleaseCandidateError(`${name} may occur at most once`)
  }
  return entries[0]
}

function requiredRepeated(
  values: ReadonlyMap<string, readonly string[]>,
  name: string,
  count: number,
): readonly string[] {
  const entries = values.get(name)
  if (!entries || entries.length !== count) {
    throw new ReleaseCandidateError(`${name} must occur exactly ${count} times`)
  }
  return entries
}

function decimalInteger(value: string, label: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new ReleaseCandidateError(`${label} is not a canonical decimal integer`)
  }
  const result = Number(value)
  if (!Number.isSafeInteger(result)) throw new ReleaseCandidateError(`${label} exceeds its bound`)
  return result
}

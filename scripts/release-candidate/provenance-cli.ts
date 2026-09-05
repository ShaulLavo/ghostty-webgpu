import {
  createReleaseSmokeProvenance,
  verifyReleaseRebuildProvenance,
  type CreateReleaseSmokeOptions,
  type VerifyReleaseRebuildOptions,
} from './provenance'
import { NATIVE_TARGETS, type NativeTarget } from '../config-resolver-native/constants'
import type { CommandRunner } from './repository'
import { ReleaseCandidateError } from './validation'

export type ReleaseProvenanceArguments =
  | { readonly mode: 'rebuild'; readonly options: VerifyReleaseRebuildOptions }
  | { readonly mode: 'smoke'; readonly options: CreateReleaseSmokeOptions }

export function parseReleaseProvenanceArguments(
  argv: readonly string[],
  repositoryRoot: string,
  commandRunner?: CommandRunner,
): ReleaseProvenanceArguments {
  const mode = argv[0]
  if (mode !== '--rebuild' && mode !== '--smoke') {
    throw new ReleaseCandidateError('exactly one release provenance mode is required')
  }
  const values = optionValues(argv.slice(1))
  const common = commonOptions(values, repositoryRoot, commandRunner)
  if (mode === '--rebuild') {
    rejectUnknown(values, [
      '--run-id',
      '--run-attempt',
      '--target',
      '--package-source-head',
      '--runner-image',
      '--runner-image-version',
      '--archive',
      '--provenance',
    ])
    return {
      mode: 'rebuild',
      options: {
        ...common,
        archivePath: required(values, '--archive'),
        provenancePath: required(values, '--provenance'),
      },
    }
  }
  rejectUnknown(values, [
    '--run-id',
    '--run-attempt',
    '--target',
    '--package-source-head',
    '--runner-image',
    '--runner-image-version',
    '--tarball',
    '--provisional',
    '--rebuild-provenance',
    '--output',
  ])
  return {
    mode: 'smoke',
    options: {
      ...common,
      tarballPath: required(values, '--tarball'),
      provisionalPath: required(values, '--provisional'),
      rebuildProvenancePath: required(values, '--rebuild-provenance'),
      outputPath: required(values, '--output'),
    },
  }
}

export function runReleaseProvenanceArguments(arguments_: ReleaseProvenanceArguments): void {
  if (arguments_.mode === 'rebuild') {
    verifyReleaseRebuildProvenance(arguments_.options)
    return
  }
  createReleaseSmokeProvenance(arguments_.options)
}

function commonOptions(
  values: ReadonlyMap<string, string>,
  repositoryRoot: string,
  commandRunner?: CommandRunner,
): Pick<
  VerifyReleaseRebuildOptions,
  | 'repositoryRoot'
  | 'packageSourceHead'
  | 'runId'
  | 'runAttempt'
  | 'target'
  | 'runnerImage'
  | 'runnerImageVersion'
  | 'commandRunner'
> {
  return {
    repositoryRoot,
    packageSourceHead: required(values, '--package-source-head'),
    runId: required(values, '--run-id'),
    runAttempt: decimalInteger(required(values, '--run-attempt'), '--run-attempt'),
    target: nativeTarget(required(values, '--target')),
    runnerImage: required(values, '--runner-image'),
    runnerImageVersion: required(values, '--runner-image-version'),
    commandRunner,
  }
}

function optionValues(argv: readonly string[]): ReadonlyMap<string, string> {
  if (argv.length % 2 !== 0)
    throw new ReleaseCandidateError('release provenance option lacks a value')
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value || value.startsWith('--') || values.has(name)) {
      throw new ReleaseCandidateError('release provenance option syntax is invalid')
    }
    values.set(name, value)
  }
  return values
}

function rejectUnknown(values: ReadonlyMap<string, string>, allowed: readonly string[]): void {
  for (const name of values.keys()) {
    if (!allowed.includes(name)) throw new ReleaseCandidateError(`unknown release option ${name}`)
  }
}

function required(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name)
  if (!value) throw new ReleaseCandidateError(`${name} must occur exactly once`)
  return value
}

function nativeTarget(value: string): NativeTarget {
  if (!NATIVE_TARGETS.includes(value as NativeTarget)) {
    throw new ReleaseCandidateError('release provenance target is invalid')
  }
  return value as NativeTarget
}

function decimalInteger(value: string, label: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new ReleaseCandidateError(`${label} is not a canonical decimal integer`)
  }
  const result = Number(value)
  if (!Number.isSafeInteger(result)) throw new ReleaseCandidateError(`${label} exceeds its bound`)
  return result
}

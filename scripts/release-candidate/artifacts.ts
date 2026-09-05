import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs'
import { canonicalObjectBytes, sha256 } from '../config-resolver-native/canonical'
import { ReleaseCandidateError } from './validation'

export type ArtifactSnapshot = {
  readonly path: string
  readonly bytes: Buffer
  readonly sha256: string
  readonly state: ArtifactFileState
}

type ArtifactFileState = {
  readonly dev: bigint
  readonly ino: bigint
  readonly mode: bigint
  readonly size: bigint
  readonly mtimeNs: bigint
  readonly ctimeNs: bigint
}

export function readArtifactSnapshot(path: string, maximumBytes: number): ArtifactSnapshot {
  let descriptor: number
  try {
    descriptor = openSync(path, readOnlyNoFollowFlags())
  } catch {
    throw new ReleaseCandidateError('release artifact is not a readable regular file')
  }
  try {
    const before = fstatSync(descriptor, { bigint: true })
    validateRegularBounded(before, maximumBytes)
    const bytes = readBoundedDescriptor(descriptor, Number(before.size))
    const after = fstatSync(descriptor, { bigint: true })
    if (!sameState(before, after) || BigInt(bytes.length) !== after.size) {
      throw new ReleaseCandidateError('release artifact changed while it was read')
    }
    return { path, bytes, sha256: sha256(bytes), state: stateOf(after) }
  } finally {
    closeSync(descriptor)
  }
}

function readBoundedDescriptor(descriptor: number, bytes: number): Buffer {
  const result = Buffer.alloc(bytes)
  let offset = 0
  while (offset < bytes) {
    const read = readSync(descriptor, result, offset, bytes - offset, offset)
    if (read === 0) throw new ReleaseCandidateError('release artifact was truncated while read')
    offset += read
  }
  const overflow = Buffer.alloc(1)
  if (readSync(descriptor, overflow, 0, 1, bytes) !== 0) {
    throw new ReleaseCandidateError('release artifact grew while it was read')
  }
  return result
}

export function assertArtifactUnchanged(snapshot: ArtifactSnapshot, maximumBytes: number): void {
  const current = readArtifactSnapshot(snapshot.path, maximumBytes)
  if (!sameRecordedState(snapshot.state, current.state) || snapshot.sha256 !== current.sha256) {
    throw new ReleaseCandidateError('release artifact changed during verification')
  }
}

export function parseCanonicalArtifact<T>(
  snapshot: ArtifactSnapshot,
  validate: (value: unknown) => T,
): T {
  let value: unknown
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes)
    value = JSON.parse(source)
  } catch {
    throw new ReleaseCandidateError('release artifact is not valid UTF-8 JSON')
  }
  const canonical = canonicalObjectBytes(value)
  if (!snapshot.bytes.equals(canonical)) {
    throw new ReleaseCandidateError('release JSON artifact is not canonical JSON+LF')
  }
  return validate(value)
}

export function writeExclusiveFile(path: string, bytes: Uint8Array, mode = 0o644): void {
  let descriptor: number
  try {
    descriptor = openSync(path, exclusiveWriteFlags(), mode)
  } catch {
    throw new ReleaseCandidateError('release output path already exists or cannot be created')
  }
  try {
    writeFileSync(descriptor, bytes)
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

export function writeCanonicalFile(path: string, value: unknown): Buffer {
  const bytes = canonicalObjectBytes(value)
  writeExclusiveFile(path, bytes)
  return bytes
}

export function acquireExclusiveLock(path: string): number {
  try {
    return openSync(path, exclusiveWriteFlags(), 0o600)
  } catch {
    throw new ReleaseCandidateError('release candidate lock already exists or cannot be acquired')
  }
}

export function closeAndSync(descriptor: number): void {
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

export function publishExclusiveFile(source: string, destination: string): void {
  try {
    linkSync(source, destination)
  } catch {
    throw new ReleaseCandidateError('release output path already exists or cannot be published')
  }
  try {
    unlinkSync(source)
  } catch {
    try {
      unlinkSync(destination)
    } catch {
      // The caller still owns the staging directory and will clean it up.
    }
    throw new ReleaseCandidateError('release staging file could not be retired')
  }
}

export function syncDirectory(path: string): void {
  let descriptor: number
  try {
    descriptor = openSync(path, constants.O_RDONLY)
  } catch {
    throw new ReleaseCandidateError('release directory cannot be opened for synchronization')
  }
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function validateRegularBounded(stats: BigIntStats, maximumBytes: number): void {
  if (!stats.isFile()) throw new ReleaseCandidateError('release artifact is not a regular file')
  if (stats.size < 1n || stats.size > BigInt(maximumBytes)) {
    throw new ReleaseCandidateError('release artifact exceeds its byte bound')
  }
}

function stateOf(stats: BigIntStats): ArtifactFileState {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  }
}

function sameState(left: BigIntStats, right: BigIntStats): boolean {
  return sameRecordedState(stateOf(left), stateOf(right))
}

function sameRecordedState(left: ArtifactFileState, right: ArtifactFileState): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function readOnlyNoFollowFlags(): number {
  return constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
}

function exclusiveWriteFlags(): number {
  return constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0)
}

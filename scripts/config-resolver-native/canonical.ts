import { closeSync, constants, fstatSync, openSync, readFileSync, type BigIntStats } from 'node:fs'
import {
  canonicalObjectBytes,
  canonicalObjectSha256,
  sha256Bytes,
} from '../../src/config-resolver/canonicalize'

const MAX_CANONICAL_JSON_BYTES = 8 * 1024 * 1024

export class NativeContractError extends Error {}

export { canonicalObjectBytes }

export function canonicalSha256(value: unknown): string {
  return canonicalObjectSha256(value)
}

export function sha256(bytes: Uint8Array): string {
  return sha256Bytes(bytes)
}

export function loadCanonicalJson(
  path: string,
  maximum = MAX_CANONICAL_JSON_BYTES,
): {
  readonly value: unknown
  readonly bytes: Buffer
  readonly sha256: string
} {
  const bytes = readStableRegularFile(path, maximum)
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new NativeContractError(`${path} is not valid UTF-8 JSON`)
  }
  const canonical = canonicalObjectBytes(value)
  if (!bytes.equals(canonical)) throw new NativeContractError(`${path} is not canonical JSON+LF`)
  return { value, bytes, sha256: sha256(bytes) }
}

export function readStableRegularFile(path: string, maximum: number): Buffer {
  let descriptor: number
  try {
    descriptor = openSync(path, readOnlyNoFollowFlags())
  } catch {
    throw new NativeContractError(`${path} is not a readable regular file`)
  }
  try {
    const before = fstatSync(descriptor, { bigint: true })
    if (!before.isFile()) throw new NativeContractError(`${path} is not a regular file`)
    if (before.size < 0n || before.size > BigInt(maximum)) {
      throw new NativeContractError(`${path} exceeds its byte bound`)
    }
    const bytes = readFileSync(descriptor)
    const after = fstatSync(descriptor, { bigint: true })
    if (!sameFileState(before, after) || BigInt(bytes.length) !== after.size) {
      throw new NativeContractError(`${path} changed while it was read`)
    }
    return bytes
  } finally {
    closeSync(descriptor)
  }
}

function readOnlyNoFollowFlags(): number {
  return constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
}

function sameFileState(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

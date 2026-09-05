import { createHash } from 'node:crypto'

type JsonObject = Readonly<Record<string, unknown>>

const MAXIMUM_DEPTH = 128
const MAXIMUM_VALUES = 1_000_000

export class CanonicalizationError extends Error {}

interface CanonicalState {
  depth: number
  values: number
  readonly ancestors: Set<object>
}

export function canonicalObjectBytes(value: unknown): Buffer {
  const state: CanonicalState = { ancestors: new Set(), depth: 0, values: 0 }
  return Buffer.from(`${canonicalValue(value, state)}\n`, 'utf8')
}

export function canonicalObjectSha256(value: unknown): string {
  return createHash('sha256').update(canonicalObjectBytes(value)).digest('hex')
}

export function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalValue(value: unknown, state: CanonicalState): string {
  countValue(state)
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return canonicalString(value)
  if (typeof value === 'number') return canonicalNumber(value)
  if (Array.isArray(value)) return canonicalArray(value, state)
  if (isPlainObject(value)) return canonicalObject(value, state)
  throw new CanonicalizationError('value is outside the canonical JSON domain')
}

function countValue(state: CanonicalState): void {
  state.values += 1
  if (state.values > MAXIMUM_VALUES) {
    throw new CanonicalizationError('canonical JSON has too many values')
  }
}

function canonicalString(value: string): string {
  assertUnicodeScalarSequence(value)
  return JSON.stringify(value)
}

function assertUnicodeScalarSequence(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit < 0xd800 || unit > 0xdfff) continue
    if (unit >= 0xdc00) throw new CanonicalizationError('canonical JSON has an unpaired surrogate')
    const next = value.charCodeAt(index + 1)
    if (!(next >= 0xdc00 && next <= 0xdfff)) {
      throw new CanonicalizationError('canonical JSON has an unpaired surrogate')
    }
    index += 1
  }
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value))
    throw new CanonicalizationError('canonical JSON number is not finite')
  return JSON.stringify(value)
}

function canonicalArray(value: readonly unknown[], state: CanonicalState): string {
  enterContainer(value, state)
  try {
    assertDenseArray(value)
    const entries: string[] = []
    for (const item of value) entries.push(canonicalValue(item, state))
    return `[${entries.join(',')}]`
  } finally {
    leaveContainer(value, state)
  }
}

function assertDenseArray(value: readonly unknown[]): void {
  const keys = Object.keys(value)
  if (keys.length !== value.length)
    throw new CanonicalizationError('canonical JSON array is sparse')
  for (let index = 0; index < value.length; index += 1) {
    if (keys[index] !== String(index)) {
      throw new CanonicalizationError('canonical JSON array has non-index properties')
    }
  }
}

function canonicalObject(value: JsonObject, state: CanonicalState): string {
  enterContainer(value, state)
  try {
    const keys = Object.keys(value).sort(compareUtf16)
    const entries: string[] = []
    for (const key of keys) {
      assertDataProperty(value, key)
      entries.push(`${canonicalString(key)}:${canonicalValue(value[key], state)}`)
    }
    return `{${entries.join(',')}}`
  } finally {
    leaveContainer(value, state)
  }
}

function assertDataProperty(value: JsonObject, key: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor?.enumerable || !('value' in descriptor)) {
    throw new CanonicalizationError('canonical JSON object has an accessor property')
  }
}

function enterContainer(value: object, state: CanonicalState): void {
  if (state.ancestors.has(value)) throw new CanonicalizationError('canonical JSON is cyclic')
  if (state.depth >= MAXIMUM_DEPTH) throw new CanonicalizationError('canonical JSON is too deep')
  state.ancestors.add(value)
  state.depth += 1
}

function leaveContainer(value: object, state: CanonicalState): void {
  state.depth -= 1
  state.ancestors.delete(value)
}

function isPlainObject(value: unknown): value is JsonObject {
  if (!value || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function compareUtf16(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

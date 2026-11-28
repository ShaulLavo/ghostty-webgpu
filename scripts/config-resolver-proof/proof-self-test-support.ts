import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { ProofContractError } from './proof-contract'

class SelfTestFailure extends Error {}

export function fail(message: string): never {
  throw new SelfTestFailure(message)
}

export function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function assertProofRejection(action: () => unknown, label: string): void {
  try {
    action()
  } catch (error) {
    if (error instanceof ProofContractError) return
    throw error
  }
  fail(`${label} was accepted`)
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const object = value as Record<string, unknown>
  const entries = Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
  return `{${entries.join(',')}}`
}

export function createFixtureDirectory(path: string, mode = 0o755): void {
  mkdirSync(path, { recursive: true, mode })
  chmodSync(path, mode)
}

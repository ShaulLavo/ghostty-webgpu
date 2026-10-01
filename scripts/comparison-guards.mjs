import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

export function verifyHash(bytes, expected, name) {
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    expected,
    `Bundle asset hash mismatch: ${name}`,
  )
}

export function cpuSample(before, after, milliseconds) {
  const prior = new Map(before.map((entry) => [entry.id, entry]))
  const ids = new Set(after.map((entry) => entry.id))
  assert(
    before.every((entry) => ids.has(entry.id)) && after.every((entry) => prior.has(entry.id)),
    'CPU process set changed during sample',
  )
  const secondsByType = {}
  for (const entry of after) {
    const delta = Math.max(0, entry.cpuTime - prior.get(entry.id).cpuTime)
    secondsByType[entry.type] = (secondsByType[entry.type] ?? 0) + delta
  }
  return {
    before,
    after,
    secondsByType,
    percentOfOneCore:
      (Object.values(secondsByType).reduce((a, b) => a + b, 0) / milliseconds) * 100_000,
    processChurn: false,
  }
}

export async function withDeadline(operation, milliseconds, expire) {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      expire()
      reject(new Error('Comparison case deadline exceeded'))
    }, milliseconds)
  })
  try {
    return await Promise.race([operation(), deadline])
  } finally {
    clearTimeout(timer)
  }
}

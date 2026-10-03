import { expect } from 'vitest'

export function expectPixelsEqual(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.byteLength, 'Pixel capture byte length').toBe(expected.byteLength)
  const firstDifference = actual.findIndex((value, index) => value !== expected[index])
  expect(firstDifference, 'First differing pixel byte').toBe(-1)
}

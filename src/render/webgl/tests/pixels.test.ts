import { afterEach, describe, expect, it, vi } from 'vitest'
import { expectPixelsEqual } from './pixels.js'

afterEach(() => vi.restoreAllMocks())

describe('pixel equality', () => {
  it('compares equal bytes without enumerating typed-array properties', () => {
    const entries = vi.spyOn(Object, 'entries')
    expectPixelsEqual(new Uint8Array([0, 127, 255, 0]), new Uint8Array([0, 127, 255, 0]))
    expect(entries.mock.calls.filter(([value]) => value instanceof Uint8Array)).toHaveLength(0)
  })

  it('accepts empty captures', () => {
    expect(() => expectPixelsEqual(new Uint8Array(), new Uint8Array())).not.toThrow()
  })

  it('compares subviews with different offsets and backing bytes', () => {
    const actual = new Uint8Array([99, 1, 2, 3, 88]).subarray(1, 4)
    const expected = new Uint8Array([1, 2, 3, 77]).subarray(0, 3)
    expect(() => expectPixelsEqual(actual, expected)).not.toThrow()
  })

  it.each([
    [new Uint8Array([1]), new Uint8Array([1, 0])],
    [new Uint8Array([1, 0]), new Uint8Array([1])],
  ])('rejects different capture lengths', (actual, expected) => {
    expect(() => expectPixelsEqual(actual, expected)).toThrow()
  })

  it.each([0, 32768, 65535])('detects a difference at byte %i', (index) => {
    const actual = new Uint8Array(65536)
    const expected = new Uint8Array(actual.length)
    actual[index] = 255
    expect(() => expectPixelsEqual(actual, expected)).toThrowError(
      expect.objectContaining({ actual: index, expected: -1 }),
    )
  })

  it('reports the first difference when several bytes differ', () => {
    const actual = new Uint8Array([0, 0, 127, 255])
    const expected = new Uint8Array([0, 0, 0, 0])
    expect(() => expectPixelsEqual(actual, expected)).toThrowError(
      expect.objectContaining({ actual: 2, expected: -1 }),
    )
  })
})

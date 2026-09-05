import { describe, expect, it } from 'vitest'

import {
  CanonicalizationError,
  canonicalObjectBytes,
  canonicalObjectSha256,
} from '../canonicalize.js'

describe('canonicalObjectBytes', () => {
  it('sorts recursively, preserves arrays, and appends exactly one LF', () => {
    const value = {
      z: [3, { b: true, a: 'å' }],
      a: -0,
      '\u20ac': 1,
      '\r': 2,
    }

    expect(canonicalObjectBytes(value).toString('utf8')).toBe(
      '{"\\r":2,"a":0,"z":[3,{"a":"å","b":true}],"€":1}\n',
    )
    expect(canonicalObjectSha256(value)).toBe(
      'd775bfadaadb06d20dcf62b6fbfcf57a8592d8272af9622e5ae4aed5d33d0ec4',
    )
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, undefined, 1n, new Date()])(
    'rejects a non-JSON value %#',
    (value) => {
      expect(() => canonicalObjectBytes(value)).toThrow(CanonicalizationError)
    },
  )

  it('rejects cycles, sparse arrays, accessors, and unpaired surrogates', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const sparse = Array.from({ length: 2 })
    delete sparse[0]
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => 1,
    })

    expect(() => canonicalObjectBytes(cyclic)).toThrow(CanonicalizationError)
    expect(() => canonicalObjectBytes(sparse)).toThrow(CanonicalizationError)
    expect(() => canonicalObjectBytes(accessor)).toThrow(CanonicalizationError)
    expect(() => canonicalObjectBytes('\ud800')).toThrow(CanonicalizationError)
    expect(() => canonicalObjectBytes('\udc00')).toThrow(CanonicalizationError)
  })
})

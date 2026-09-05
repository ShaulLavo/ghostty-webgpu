import { describe, expect, it } from 'vitest'

import * as rootEntry from '../../index.js'
import * as resolverEntry from '../index.js'

describe('config resolver entry point', () => {
  it('exports only the zero-option host function at runtime', () => {
    expect(Object.keys(resolverEntry)).toEqual(['resolveGhosttyConfigAppearance'])
    expect(resolverEntry.resolveGhosttyConfigAppearance).toHaveLength(0)
  })

  it('does not leak the host resolver through the browser-safe root', () => {
    expect('resolveGhosttyConfigAppearance' in rootEntry).toBe(false)
  })
})

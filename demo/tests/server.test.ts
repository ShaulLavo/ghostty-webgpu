import { sep } from 'node:path'

import { expect, it } from 'vitest'

import { DEFAULT_PTY_CWD } from '../src/server.js'

it('removes the trailing separator from the default PTY working directory', () => {
  expect(DEFAULT_PTY_CWD.endsWith(sep)).toBe(false)
})

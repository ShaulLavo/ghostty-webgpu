import { expect, it, vi } from 'vitest'
import { stringifyChunked } from '@discoveryjs/json-ext'

vi.mock('@discoveryjs/json-ext', () => ({ stringifyChunked: () => ['"intercepted"'] }))

it('intercepts a third-party browser module while its real exports remain observable', async () => {
  expect([...stringifyChunked({ normal: true })]).toEqual(['"intercepted"'])
  const actual =
    await vi.importActual<typeof import('@discoveryjs/json-ext')>('@discoveryjs/json-ext')
  expect([...actual.stringifyChunked({ normal: true })]).toEqual(['{"normal":true}'])
})

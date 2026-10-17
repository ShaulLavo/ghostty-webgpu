import { expect, test } from 'vitest'
import { parseGhostFrames } from './ghost-frames.js'

test('parses the dimensions and runs of a valid frame', () => {
  const frame = parseGhostFrames('3 1\nA B')
  expect(frame.width).toBe(3)
  expect(frame.rows).toBe(1)
  expect(frame.frames[0]?.[0]).toEqual([
    { col: 0, glow: false, text: 'A' },
    { col: 2, glow: false, text: 'B' },
  ])
})

test.each(['unavailable', '3\nABC', '0 1\nA', '3 0\nABC', '3.5 1\nABC', 'NaN 1\nA'])(
  'rejects invalid dimensions before a frame reaches the renderer: %s',
  (packed) => {
    expect(() => parseGhostFrames(packed)).toThrow(TypeError)
  },
)

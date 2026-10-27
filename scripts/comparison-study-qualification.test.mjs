import assert from 'node:assert/strict'
import { test } from 'node:test'
import { studyCanvases, qualifyStudyPaint } from './study-qualification.mjs'

const canvas = (context, width = 700, height = 570) => ({
  context,
  width,
  height,
  bounds: { x: 0, y: 0, width: 700, height: 570 },
})

test('rejects the oversized active WebGL backing behind a correctly sized overlay', () => {
  const info = { dpr: 1, canvases: [canvas('2d'), canvas('webgl2', 1400, 1140)] }
  assert.throws(() => studyCanvases(info, 'xterm-webgl', 1), /1400x1140/)
})

test('uses the active WebGL canvas rather than the first overlay', () => {
  const active = canvas('webgl2')
  assert.deepEqual(studyCanvases({ dpr: 1, canvases: [canvas('2d'), active] }, 'xterm-webgl', 1), [
    active,
  ])
})

test('rejects quarter-painted output even when the backing dimensions match', () => {
  const pixels = Buffer.alloc(16 * 4)
  for (let i = 0; i < 4; i++) pixels.set([25, 100, 200, 255], i * 4)
  assert.throws(() => qualifyStudyPaint(pixels), /4\/16/)
  for (let i = 0; i < 16; i++) pixels.set([25, 100, 200, 255], i * 4)
  assert.deepEqual(qualifyStudyPaint(pixels), { matchingPixels: 16, pixelCount: 16 })
})

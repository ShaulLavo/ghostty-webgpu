import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderedFrame } from './comparison-render.mjs'

function coordinatedFrame() {
  const frame = { terminal: 0, operation: 'drawFrame', category: 'js', start: 20, end: 25 }
  const encode = {
    terminal: 0,
    operation: 'encode',
    category: 'commands',
    start: 21,
    end: 24,
    commands: [7],
  }
  const submission = {
    terminal: -1,
    operation: 'submitGroup',
    category: 'commands',
    start: 28,
    end: 30,
    commands: [7, 8],
  }
  const records = {
    timeOrigin: 1_000,
    ownership: [{ terminal: 0, backend: 'webgpu' }],
    markers: [],
    spans: [
      { terminal: 0, operation: 'write', category: 'parse', start: 11, end: 12 },
      frame,
      encode,
      submission,
    ],
  }
  const capture = { operation: 'write', started: 1_010, timestamp: 1_040 }
  return { records, capture, frame, encode, submission }
}

test('joins a default WebGPU encoded command to its actual grouped submission', () => {
  const f = coordinatedFrame()
  const result = renderedFrame(f.records, f.capture)
  assert.equal(result.frame, f.frame)
  assert.equal(result.boundary, f.submission)
  assert.equal(result.boundary.end, 30)
})

test('unsubmitted encoding and unrelated later submission fail closed', () => {
  for (const commands of [undefined, [], [8]]) {
    const f = coordinatedFrame()
    f.submission.commands = commands
    assert.throws(() => renderedFrame(f.records, f.capture), /submitted glyph frame/)
  }
})

test('a linked command submitted outside the capture or before encoding fails closed', () => {
  for (const [start, end] of [
    [41, 42],
    [22, 23],
  ]) {
    const f = coordinatedFrame()
    f.submission.start = start
    f.submission.end = end
    assert.throws(() => renderedFrame(f.records, f.capture), /submitted glyph frame/)
  }
})

test('retained direct-submission traces keep their original frame boundary', () => {
  const f = coordinatedFrame()
  f.encode.operation = 'submit'
  f.records.spans.pop()
  const result = renderedFrame(f.records, f.capture)
  assert.equal(result.frame, f.frame)
  assert.equal(result.boundary, f.encode)
})

import { describe, expect, it } from 'vitest'

import {
  MAX_PTY_COLS,
  MAX_PTY_INPUT_BYTES,
  MAX_PTY_ROWS,
  parseClientMessage,
} from '../src/protocol.js'

describe('demo WebSocket protocol', () => {
  it('copies binary PTY input without text decoding', () => {
    const backing = new Uint8Array([9, 0, 0xff, 0x80, 10])
    const input = backing.subarray(1, 4)
    const parsed = parseClientMessage(input)

    expect(parsed).toEqual({ type: 'input', bytes: new Uint8Array([0, 0xff, 0x80]) })
    backing.fill(7)
    expect(parsed).toEqual({ type: 'input', bytes: new Uint8Array([0, 0xff, 0x80]) })
  })

  it('accepts the exact bounded resize message', () => {
    expect(parseClientMessage('{"type":"resize","cols":120,"rows":40}')).toEqual({
      type: 'resize',
      cols: 120,
      rows: 40,
    })
    expect(
      parseClientMessage(
        JSON.stringify({ type: 'resize', cols: MAX_PTY_COLS, rows: MAX_PTY_ROWS }),
      ),
    ).toMatchObject({ cols: MAX_PTY_COLS, rows: MAX_PTY_ROWS })
  })

  it.each([
    'not json',
    'null',
    '[]',
    '{}',
    '{"type":"input","cols":80,"rows":24}',
    '{"type":"resize","columns":80,"rows":24}',
    '{"type":"resize","cols":80,"rows":24,"extra":true}',
    '{"type":"resize","cols":0,"rows":24}',
    '{"type":"resize","cols":80,"rows":-1}',
    '{"type":"resize","cols":1.5,"rows":24}',
    `{"type":"resize","cols":${MAX_PTY_COLS + 1},"rows":24}`,
    `{"type":"resize","cols":80,"rows":${MAX_PTY_ROWS + 1}}`,
  ])('rejects invalid text message %s', (message) => {
    expect(() => parseClientMessage(message)).toThrow()
  })

  it('rejects an oversized binary message', () => {
    expect(() => parseClientMessage(new Uint8Array(MAX_PTY_INPUT_BYTES + 1))).toThrow(RangeError)
  })
})

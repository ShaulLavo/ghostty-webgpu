import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PixelFrame } from './pixel-frame.js'
import type { Canvas2dContext } from './painter.js'

// Node tests model the external ImageData constructor's alias contract, not browser rendering.
class ImageDataFixture {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}

function fixture() {
  const memory = new WebAssembly.Memory({ initial: 1 })
  const putImageData = vi.fn()
  const frame = new PixelFrame(memory, { putImageData } as unknown as Canvas2dContext)
  const output = { offset: 32, width: 4, height: 6, generation: 0 }
  frame.bind(output, 2)
  return { memory, putImageData, frame, output }
}

beforeEach(() => vi.stubGlobal('ImageData', ImageDataFixture))
afterEach(() => vi.unstubAllGlobals())

describe('WASM output handoff lifetime', () => {
  it('aliases output bytes and reuses only the same view identity', () => {
    const { frame, memory } = fixture()
    const image = frame.getImage()
    new Uint8Array(memory.buffer)[32] = 117
    expect(image.data[0]).toBe(117)
    expect(image.data.buffer).toBe(memory.buffer)
    expect(frame.getImage()).toBe(image)
    expect(frame.metrics.copiedFrameBytes).toBe(0)
  })

  it('refreshes after ordinary memory growth detaches the old view', () => {
    const { frame, memory } = fixture()
    const old = frame.getImage()
    memory.grow(1)
    expect(old.data.byteLength).toBe(0)
    expect(frame.getImage() === old).toBe(false)
    expect(frame.getImage().data.buffer).toBe(memory.buffer)
    expect(frame.metrics.bufferChanges).toBe(1)
  })

  it.each([{ offset: 160 }, { width: 2, height: 12 }, { generation: 1 }])(
    'refreshes a changed output identity %j',
    (change) => {
      const { frame, output } = fixture()
      const old = frame.getImage()
      frame.bind({ ...output, ...change }, 2)
      const next = frame.getImage()
      expect(next).not.toBe(old)
      expect(next.data.byteOffset).toBe(change.offset ?? output.offset)
      expect(next.width).toBe(change.width ?? output.width)
      expect(next.height).toBe(change.height ?? output.height)
    },
  )

  it('coalesces adjacent dirty rows without uploading gaps', () => {
    const { frame, putImageData } = fixture()
    frame.present()
    putImageData.mockClear()
    frame.markRow(0)
    frame.markRow(2)
    frame.present()
    expect(putImageData.mock.calls.map((call) => call.slice(3))).toEqual([
      [0, 0, 4, 2],
      [0, 4, 4, 2],
    ])
    putImageData.mockClear()
    frame.markRow(0)
    frame.markRow(1)
    frame.present()
    expect(putImageData.mock.calls.map((call) => call.slice(3))).toEqual([[0, 0, 4, 4]])
  })

  it('retains all scheduled damage after a later upload fails', () => {
    const { frame, putImageData } = fixture()
    frame.present()
    frame.markRow(0)
    frame.markRow(2)
    putImageData.mockClear()
    putImageData.mockImplementationOnce(() => undefined)
    putImageData.mockImplementationOnce(() => {
      throw new TypeError('Injected output failure')
    })
    expect(() => frame.present()).toThrow('Injected output failure')
    putImageData.mockClear()
    frame.present()
    expect(putImageData.mock.calls.map((call) => call.slice(3))).toEqual([
      [0, 0, 4, 2],
      [0, 4, 4, 2],
    ])
  })

  it('dirties transported destinations and invalidates after context loss', () => {
    const { frame, putImageData } = fixture()
    frame.present()
    putImageData.mockClear()
    frame.markTransportedRows(-1)
    frame.present()
    expect(putImageData.mock.calls[0]?.slice(3)).toEqual([0, 0, 4, 4])
    const old = frame.getImage()
    frame.invalidate()
    expect(frame.getImage() === old).toBe(false)
    frame.present()
    expect(putImageData.mock.lastCall?.slice(3)).toEqual([0, 0, 4, 6])
  })

  it('rejects invalid rows, shape, memory bounds and disposed access', () => {
    const { frame, output } = fixture()
    expect(() => frame.markRow(-1)).toThrow()
    expect(() => frame.markRow(3)).toThrow()
    expect(() => frame.markTransportedRows(0.5)).toThrow()
    expect(() => frame.bind({ ...output, offset: 65536 }, 2)).toThrow()
    expect(() => frame.bind({ ...output, width: 0 }, 2)).toThrow()
    expect(() => frame.bind(output, 4)).toThrow()
    frame.dispose()
    expect(() => frame.getImage()).toThrow()
    expect(() => frame.markRow(0)).toThrow()
  })
})

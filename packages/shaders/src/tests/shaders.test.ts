import { describe, expect, expectTypeOf, it } from 'vitest'
import { createShaderAddon, type CompiledShader } from '../index.js'
import { FrameSchedule } from '../frame-schedule.js'
import {
  packShaderUniforms,
  SHADER_UNIFORM_BYTE_LENGTH,
  SHADER_UNIFORM_FIELDS,
} from '../uniforms.js'
import { UniformState } from '../terminal-uniforms.js'

it('accepts full compiler objects structurally and one-language artifacts', () => {
  const full: {
    schemaVersion: 1
    uniformLayout: 'ghostty-v1'
    wgsl: string
    glsl: string
    entryPoint: 'main'
    webgl: { uniformBlock: string | null; channel0: string | null }
  } = {
    schemaVersion: 1,
    uniformLayout: 'ghostty-v1',
    wgsl: 'compiled wgsl',
    glsl: 'compiled glsl',
    entryPoint: 'main',
    webgl: { uniformBlock: null, channel0: null },
  }
  expectTypeOf(full).toExtend<CompiledShader>()
  expect(createShaderAddon(full).name).toBe('ghostty-webgpu-shaders')
  expect(createShaderAddon({ wgsl: 'compiled' }).name).toBe('ghostty-webgpu-shaders')
  expect(createShaderAddon({ glsl: 'compiled' }).name).toBe('ghostty-webgpu-shaders')
  expect(() => createShaderAddon({ wgsl: '' })).toThrow('must contain WGSL or GLSL')
  // @ts-expect-error source text is not a compiled artifact
  expect(() => createShaderAddon('shader')).toThrow('compiled WGSL or GLSL shader object')
})

it('preserves the shared ABI offsets and zeroes reused buffers', () => {
  expect(SHADER_UNIFORM_BYTE_LENGTH).toBe(4496)
  const fields = new Map(SHADER_UNIFORM_FIELDS.map((field) => [field.name, field.offset]))
  expect(fields.get('iTime')).toBe(12)
  expect(fields.get('iFrame')).toBe(24)
  expect(fields.get('iPalette')).toBe(304)
  const data = packShaderUniforms({ iResolution: [40, 20, 1], iTime: 3, iFrame: 9 })
  expect(new DataView(data).getFloat32(12, true)).toBe(3)
  expect(new DataView(data).getInt32(24, true)).toBe(9)
  packShaderUniforms({}, data)
  expect(new DataView(data).getFloat32(12, true)).toBe(0)
  expect(new DataView(data).getFloat32(8, true)).toBe(1)
})

describe('frame pacing', () => {
  it('retains elapsed time and the latest dirty frame while a submission is unfinished', () => {
    const frames = new FrameSchedule()
    frames.setActive(true, 0)
    frames.draw(10, () => true)
    const seen: number[] = []
    frames.draw(20, () => false)
    frames.invalidate()
    frames.draw(90, (frame) => {
      seen.push(frame.time, frame.delta, frame.frame)
      return true
    })
    expect(seen).toEqual([0.09, 0.08, 1])
  })
  it('freezes effect time while allowing changed terminal state to redraw', () => {
    const frames = new FrameSchedule()
    frames.setActive(true, 0)
    frames.draw(100, () => true)
    frames.setActive(false, 100)
    expect(frames.pending).toBe(false)
    frames.invalidate()
    frames.draw(10000, (frame) => {
      expect(frame.time).toBe(0.1)
      expect(frame.delta).toBe(0)
      return true
    })
    frames.setActive(true, 10000)
    expect(frames.timeAt(10100)).toBe(0.2)
  })
})

it('keeps pointer release signs and previous cursor style/color', () => {
  const state = new UniformState()
  state.pointer('pointerdown', 20, 30)
  state.pointer('pointermove', 25, 35)
  state.pointer('pointerup', 25, 35)
  state.pointer('pointermove', 40, 50)
  expect(state.mouse).toEqual([40, 50, -20, -30])
  state.update([1, 2, 3, 4], [1, 0, 0, 1], 2, 1)
  state.update([5, 6, 7, 8], [0, 0, 1, 1], 3, 2)
  expect(state.previous).toEqual([1, 2, 3, 4])
  expect(state.previousStyle).toBe(2)
  expect(state.previousColor).toEqual([1, 0, 0, 1])
})

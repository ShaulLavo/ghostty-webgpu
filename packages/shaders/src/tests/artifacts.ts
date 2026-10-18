import copy from './fixtures/copy.json'
import uniforms from './fixtures/uniforms.json'
import time from './fixtures/time.json'
import type { CompiledShader } from '../index.js'

function artifact(value: typeof copy | typeof uniforms | typeof time): CompiledShader {
  if (value.schemaVersion !== 1 || value.uniformLayout !== 'ghostty-v1')
    throw new TypeError('Invalid shader fixture ABI')
  return { ...value, schemaVersion: value.schemaVersion, uniformLayout: value.uniformLayout }
}
export const copyShader = artifact(copy)
export const uniformShader = artifact(uniforms)
export const timeShader = artifact(time)
export const greenShader: CompiledShader = {
  wgsl: '@fragment fn main() -> @location(0) vec4<f32> { return vec4<f32>(0.0, 1.0, 0.0, 1.0); }',
  glsl: '#version 300 es\nprecision highp float; out vec4 color; void main() { color = vec4(0.0, 1.0, 0.0, 1.0); }',
  webgl: { channel0: null, uniformBlock: null },
}
export function language(shader: CompiledShader, backend: 'webgpu' | 'webgl2'): CompiledShader {
  if (backend === 'webgpu' && shader.wgsl)
    return { wgsl: shader.wgsl, entryPoint: shader.entryPoint }
  if (backend === 'webgl2' && shader.glsl) return { glsl: shader.glsl, webgl: shader.webgl }
  throw new TypeError('Missing fixture backend')
}

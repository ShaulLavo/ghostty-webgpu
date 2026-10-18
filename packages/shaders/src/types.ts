import type { Extension } from 'ghostty-webgpu'

export type ShaderVector2 = readonly [number, number]
export type ShaderVector3 = readonly [number, number, number]
export type ShaderVector4 = readonly [number, number, number, number]
export interface ShaderUniformField {
  readonly name: string
  readonly type: 'float' | 'int' | 'vec3' | 'vec4'
  readonly offset: number
  readonly count: number
  readonly stride: number
}

interface ShaderBindings {
  readonly entryPoint?: string
  readonly schemaVersion?: 1
  readonly uniformLayout?: 'ghostty-v1'
  readonly webgl?: {
    readonly uniformBlock: string | null
    readonly channel0: string | null
  }
}

/** Accepts full compiler output and artifacts containing only one backend. */
export type CompiledShader = ShaderBindings &
  (
    | { readonly wgsl: string; readonly glsl?: string }
    | { readonly wgsl?: string; readonly glsl: string }
  )

export interface ShaderAddonOptions {
  readonly backend?: 'webgpu' | 'webgl2'
  readonly paused?: boolean
  readonly onError?: (error: ShaderAddonError) => void
}

export interface ShaderAddonApi {
  /** Resolves after installation, including when installed before terminal.open(). */
  readonly ready: Promise<void>
  /** False means a newer replacement or disposal superseded this request. */
  setShader(shader: CompiledShader): Promise<boolean>
  /** Freezes effect time; terminal updates still draw. */
  setPaused(paused: boolean): void
}

export type ShaderAddon = Extension<ShaderAddonApi>

export class ShaderAddonError extends Error {
  constructor(
    readonly code: 'artifact' | 'backend' | 'capture' | 'disposed' | 'gpu' | 'worker',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ShaderAddonError'
  }
}

export function validateShader(shader: CompiledShader): void {
  if (!shader || typeof shader !== 'object')
    throw new ShaderAddonError('artifact', 'Pass a compiled WGSL or GLSL shader object.')
  if (shader.schemaVersion !== undefined && shader.schemaVersion !== 1)
    throw new ShaderAddonError('artifact', 'Use shader artifact schema version 1.')
  if (shader.uniformLayout !== undefined && shader.uniformLayout !== 'ghostty-v1')
    throw new ShaderAddonError('artifact', 'Use the ghostty-v1 uniform layout.')
  if (typeof shader.wgsl === 'string' && shader.wgsl.trim()) return
  if (typeof shader.glsl === 'string' && shader.glsl.trim()) return
  throw new ShaderAddonError('artifact', 'The compiled shader must contain WGSL or GLSL output.')
}

import { createGhosttyError } from '../../core/error.js'
import type { StampStorage } from './stamp-cache.js'

// Declared here rather than imported from core/assets.ts: Vite inlines these small files as
// base64, and that copy must stay in the lazily loaded Canvas chunk.
export const canvasWasmAssets = {
  canvasCompose: new URL('../../../canvas-compose.wasm', import.meta.url),
  canvasComposeScalar: new URL('../../../canvas-compose-scalar.wasm', import.meta.url),
} as const

export interface ComposeExports {
  readonly memory: WebAssembly.Memory
  compose_alloc(bytes: number): number
  compose_free(offset: number): number
  compose_clear(
    ptr: number,
    width: number,
    height: number,
    x: number,
    y: number,
    w: number,
    h: number,
  ): number
  compose_fill(
    ptr: number,
    width: number,
    height: number,
    x: number,
    y: number,
    w: number,
    h: number,
    rgba: number,
    opacity: number,
  ): number
  compose_stamp(
    ptr: number,
    width: number,
    height: number,
    source: number,
    sw: number,
    sh: number,
    stride: number,
    kind: number,
    x: number,
    y: number,
    cx: number,
    cy: number,
    cw: number,
    ch: number,
    tint: number,
    opacity: number,
  ): number
  compose_move(
    ptr: number,
    width: number,
    height: number,
    sourceY: number,
    targetY: number,
    rows: number,
  ): number
}

export class ComposeKernel implements StampStorage {
  readonly memory: WebAssembly.Memory

  constructor(readonly exports: ComposeExports) {
    this.memory = exports.memory
  }

  allocate(bytes: number): number {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 268435440)
      throw createGhosttyError(
        'canvas.allocate',
        'Canvas allocation requires a bounded positive byte count',
      )
    const offset = this.exports.compose_alloc(bytes)
    if (!offset)
      throw createGhosttyError('canvas.allocate', 'Canvas compositor exhausted its memory')
    return offset
  }

  release(offset: number): void {
    this.check(this.exports.compose_free(offset))
  }

  check(result: number): void {
    if (result === 1) return
    throw createGhosttyError(
      'canvas.compose',
      'Canvas compositor rejected an out-of-bounds operation',
    )
  }

  static async create(
    source: string | URL = canvasWasmAssets.canvasCompose,
  ): Promise<ComposeKernel> {
    try {
      const bytes = await (takePrefetch(source) ?? compositorAssetBytes(source))
      const { instance } = await WebAssembly.instantiate(bytes)
      return new ComposeKernel(instance.exports as unknown as ComposeExports)
    } catch (cause) {
      throw createGhosttyError('canvas.load', 'Canvas pixel composition is unavailable', cause)
    }
  }
}

let prefetch: { source: string | URL; bytes: Promise<ArrayBuffer> } | undefined

export function prefetchComposeKernel(source: string | URL = canvasWasmAssets.canvasCompose): void {
  if (prefetch?.source === source) return
  const bytes = compositorAssetBytes(source)
  prefetch = { source, bytes }
  void bytes.catch(() => {
    if (prefetch?.bytes === bytes) prefetch = undefined
  })
}

function takePrefetch(source: string | URL): Promise<ArrayBuffer> | undefined {
  if (prefetch?.source !== source) return
  const { bytes } = prefetch
  prefetch = undefined
  return bytes.catch(() => compositorAssetBytes(source))
}

async function compositorAssetBytes(source: string | URL): Promise<ArrayBuffer> {
  const bytes = await compositorBytes(source)
  if (WebAssembly.validate(bytes)) return bytes
  if (source !== canvasWasmAssets.canvasCompose) {
    throw createGhosttyError('canvas.load', 'Canvas compositor is not valid WebAssembly')
  }
  return compositorBytes(canvasWasmAssets.canvasComposeScalar)
}

async function compositorBytes(source: string | URL): Promise<ArrayBuffer> {
  const response = await fetch(source)
  if (!response.ok) throw createGhosttyError('canvas.load', 'Canvas compositor download failed')
  return response.arrayBuffer()
}

import { createGhosttyError } from '../../core/error.js'
import type { StampStorage } from './stamp-cache.js'

import { canvasWasmAssets, loadComposeKernelBytes } from './kernel-source.js'

export { canvasWasmAssets } from './kernel-source.js'

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
      const bytes = await loadComposeKernelBytes(source)
      const { instance } = await WebAssembly.instantiate(bytes)
      return new ComposeKernel(instance.exports as unknown as ComposeExports)
    } catch (cause) {
      throw createGhosttyError('canvas.load', 'Canvas pixel composition is unavailable', cause)
    }
  }
}

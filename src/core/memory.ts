import { ABI_SCHEMA_VERSION } from './abi.js'
import type { AbiLayout, AbiLayouts, AbiManifest, GhosttyWasmExports } from './abi.js'
import { createGhosttyError } from './error.js'

const decoder = new TextDecoder()
const encoder = new TextEncoder()

export interface WasmAllocation {
  length: number
  pointer: number
}

export class WasmMemory {
  readonly exports: GhosttyWasmExports

  constructor(exports: GhosttyWasmExports) {
    this.exports = exports
  }

  get bytes(): Uint8Array {
    return new Uint8Array(this.exports.memory.buffer)
  }

  get view(): DataView {
    return new DataView(this.exports.memory.buffer)
  }

  allocate(length: number): number {
    const pointer = this.exports.ghostty_wasm_alloc(length)
    if (pointer !== 0) {
      this.bytes.fill(0, pointer, pointer + length)
      return pointer
    }
    throw createGhosttyError('ghostty_wasm_alloc', `Unable to allocate ${length} wasm bytes`)
  }

  allocateBytes(value: string | Uint8Array): WasmAllocation {
    const bytes = typeof value === 'string' ? encoder.encode(value) : value
    // ghostty_wasm_alloc returns null for a zero length, which is not a failure.
    if (bytes.length === 0) return { length: 0, pointer: 0 }

    const pointer = this.allocate(bytes.length)
    this.bytes.set(bytes, pointer)
    return { length: bytes.length, pointer }
  }

  allocateOpaque(): number {
    const pointer = this.exports.ghostty_wasm_alloc_opaque()
    if (pointer !== 0) return pointer
    throw createGhosttyError(
      'ghostty_wasm_alloc_opaque',
      'Unable to allocate an opaque handle pointer',
    )
  }

  free(pointer: number, length: number): void {
    this.exports.ghostty_wasm_free(pointer, length)
  }

  freeBytes(allocation: WasmAllocation): void {
    if (allocation.pointer === 0) return
    this.free(allocation.pointer, allocation.length)
  }

  freeOpaque(pointer: number): void {
    this.exports.ghostty_wasm_free_opaque(pointer)
  }

  readCString(pointer: number): string {
    let end = pointer
    while (this.bytes[end] !== 0) end += 1
    return decoder.decode(this.bytes.subarray(pointer, end))
  }

  readHandle(pointer: number): number {
    return this.view.getUint32(pointer, true)
  }

  takeOpaque(pointer: number, operation: string): number {
    const handle = this.exports.ghostty_wasm_take_opaque(pointer)
    if (handle !== 0) return handle
    throw createGhosttyError(operation, `${operation} returned a null handle`)
  }

  readString(pointer: number): string {
    const data = this.view.getUint32(pointer, true)
    const length = this.view.getUint32(pointer + 4, true)
    if (length === 0) return ''
    return decoder.decode(this.bytes.subarray(data, data + length))
  }

  decode(pointer: number, length: number): string {
    return decoder.decode(this.bytes.subarray(pointer, pointer + length))
  }
}

export function parseAbiLayouts(memory: WasmMemory): AbiLayouts {
  const pointer = memory.exports.ghostty_type_json()
  const json = memory.readCString(pointer)
  const manifest = JSON.parse(json) as AbiManifest
  if (manifest.schema !== ABI_SCHEMA_VERSION) {
    throw createGhosttyError(
      'ghostty_type_json',
      `Unsupported ABI manifest schema ${manifest.schema}; expected ${ABI_SCHEMA_VERSION}`,
    )
  }
  return manifest.types
}

export function requireLayout(layouts: AbiLayouts, name: string): AbiLayout {
  const descriptor = layouts[name]
  if (!descriptor) {
    throw createGhosttyError('ghostty_type_json', `Required ABI layout is missing: ${name}`)
  }
  if (descriptor.kind === 'struct' || descriptor.kind === 'union') {
    return descriptor as AbiLayout
  }
  throw createGhosttyError('ghostty_type_json', `Required ABI type is not a layout: ${name}`)
}

import { ABI_SCHEMA_VERSION } from './abi.js'
import type { AbiLayout, AbiLayouts, AbiManifest, GhosttyWasmExports } from './abi.js'
import { createGhosttyError } from './error.js'

const decoder = new TextDecoder()
const encoder = new TextEncoder()
/** Bytes reserved once per runtime for write input and small native call arguments. */
export const WASM_SCRATCH_BYTES = 64 * 1024
const layoutCacheLimit = 4
const layoutCache = new Map<string, AbiLayouts>()

export interface WasmAllocation {
  length: number
  pointer: number
}

export class WasmMemory {
  readonly exports: GhosttyWasmExports
  private cachedBytes: Uint8Array
  private cachedView: DataView
  private scratchPointer = 0
  private scratchBusy = false

  constructor(exports: GhosttyWasmExports) {
    this.exports = exports
    this.cachedBytes = new Uint8Array(exports.memory.buffer)
    this.cachedView = new DataView(exports.memory.buffer)
  }

  get bytes(): Uint8Array {
    const buffer = this.exports.memory.buffer
    if (this.cachedBytes.buffer !== buffer) this.cachedBytes = new Uint8Array(buffer)
    return this.cachedBytes
  }

  get view(): DataView {
    const buffer = this.exports.memory.buffer
    if (this.cachedView.buffer !== buffer) this.cachedView = new DataView(buffer)
    return this.cachedView
  }

  allocate(length: number): number {
    const pointer = this.allocateRaw(length)
    this.bytes.fill(0, pointer, pointer + length)
    return pointer
  }

  /** Uninitialized bytes for callers that overwrite the whole range. */
  allocateRaw(length: number): number {
    const pointer = this.exports.ghostty_wasm_alloc(length)
    if (pointer !== 0) return pointer
    throw createGhosttyError('ghostty_wasm_alloc', `Unable to allocate ${length} wasm bytes`)
  }

  allocateBytes(value: string | Uint8Array): WasmAllocation {
    const bytes = typeof value === 'string' ? encoder.encode(value) : this.stableInput(value)
    // ghostty_wasm_alloc returns null for a zero length, which is not a failure.
    if (bytes.length === 0) return { length: 0, pointer: 0 }

    const pointer = this.allocateRaw(bytes.length)
    this.bytes.set(bytes, pointer)
    return { length: bytes.length, pointer }
  }

  /**
   * Zeroed bytes for one synchronous native call. Uses the shared scratch region when it is
   * free and large enough; release with `release` before the region can be borrowed again.
   */
  borrow(length: number): number {
    if (this.scratchBusy || length > WASM_SCRATCH_BYTES) return this.allocate(length)
    const pointer = this.claimScratch()
    this.bytes.fill(0, pointer, pointer + length)
    return pointer
  }

  release(pointer: number, length: number): void {
    if (pointer === this.scratchPointer && this.scratchBusy) {
      this.scratchBusy = false
      return
    }
    this.free(pointer, length)
  }

  /**
   * Copies input into wasm memory and passes it to `use`. Input that fits the free scratch
   * region skips malloc, free and zero-fill; strings encode straight into linear memory.
   */
  withBytes(value: string | Uint8Array, use: (pointer: number, length: number) => void): void {
    const input = typeof value === 'string' ? value : this.stableInput(value)
    if (this.scratchBusy || input.length > WASM_SCRATCH_BYTES) {
      this.withAllocation(input, use)
      return
    }
    const pointer = this.claimScratch()
    let length = -1
    try {
      length = this.stageScratch(pointer, input)
      if (length >= 0) use(pointer, length)
    } finally {
      this.scratchBusy = false
    }
    if (length < 0) this.withAllocation(input, use)
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

  /** Frees the scratch region; a later borrow allocates a fresh one. */
  dispose(): void {
    if (this.scratchPointer === 0) return
    this.free(this.scratchPointer, WASM_SCRATCH_BYTES)
    this.scratchPointer = 0
    this.scratchBusy = false
  }

  readCString(pointer: number): string {
    const bytes = this.bytes
    const end = bytes.indexOf(0, pointer)
    return decoder.decode(bytes.subarray(pointer, end < 0 ? bytes.length : end))
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

  private claimScratch(): number {
    if (this.scratchPointer === 0) this.scratchPointer = this.allocateRaw(WASM_SCRATCH_BYTES)
    this.scratchBusy = true
    return this.scratchPointer
  }

  /** Copies views of linear memory, which an allocation that grows memory would detach. */
  private stableInput(value: Uint8Array): Uint8Array {
    if (value.buffer !== this.exports.memory.buffer) return value
    const copy = new Uint8Array(value.length)
    copy.set(value)
    return copy
  }

  /** Returns the staged length, or -1 when a string's UTF-8 overflows the region. */
  private stageScratch(pointer: number, value: string | Uint8Array): number {
    const target = this.bytes.subarray(pointer, pointer + WASM_SCRATCH_BYTES)
    if (typeof value !== 'string') {
      target.set(value)
      return value.length
    }
    const result = encoder.encodeInto(value, target)
    return result.read === value.length ? result.written : -1
  }

  private withAllocation(
    value: string | Uint8Array,
    use: (pointer: number, length: number) => void,
  ): void {
    const input = this.allocateBytes(value)
    try {
      use(input.pointer, input.length)
    } finally {
      this.freeBytes(input)
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function parseManifest(json: string): AbiLayouts {
  const manifest = JSON.parse(json) as AbiManifest
  if (manifest.schema !== ABI_SCHEMA_VERSION) {
    throw createGhosttyError(
      'ghostty_type_json',
      `Unsupported ABI manifest schema ${manifest.schema}; expected ${ABI_SCHEMA_VERSION}`,
    )
  }
  return deepFreeze(manifest.types)
}

export function parseAbiLayouts(memory: WasmMemory): AbiLayouts {
  const json = memory.readCString(memory.exports.ghostty_type_json())
  const cached = layoutCache.get(json)
  if (cached) return cached
  const layouts = parseManifest(json)
  // A handful of distinct artifacts per page at most; drop the oldest beyond that.
  if (layoutCache.size >= layoutCacheLimit) layoutCache.delete(layoutCache.keys().next().value!)
  layoutCache.set(json, layouts)
  return layouts
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

export function fieldOffset(layout: AbiLayout, field: string): number {
  const value = layout.fields[field]
  if (value) return value.offset
  throw createGhosttyError('ghostty_type_json', `Required ABI field is missing: ${field}`)
}

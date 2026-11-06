import { ZigFrameBuilder } from 'ghostty-source/core/zig-frame.ts'
import { WebGpuTextPass } from 'ghostty-source/render/webgpu/text-pass.ts'
import { WebGlTextPass } from 'ghostty-source/render/webgl/text-pass.ts'

const stats = {
  buildCalls: 0,
  buildMs: 0,
  uploadCalls: 0,
  uploadMs: 0,
  uploadBytes: 0,
  uploadOperations: 0,
}
const builders = new Set<ZigFrameBuilder>()
const build = ZigFrameBuilder.prototype.build
ZigFrameBuilder.prototype.build = function (options) {
  const started = performance.now()
  try {
    return build.call(this, options)
  } finally {
    stats.buildMs += performance.now() - started
    stats.buildCalls += 1
    builders.add(this)
  }
}
const gpuUpload = WebGpuTextPass.prototype.uploadFrame
WebGpuTextPass.prototype.uploadFrame = function (frame, updates) {
  const started = performance.now()
  const operations = gpuUpload.call(this, frame, updates)
  stats.uploadMs += performance.now() - started
  stats.uploadCalls += 1
  stats.uploadBytes += this.frameUploadedBytes
  stats.uploadOperations += operations
  return operations
}
const glUpload = WebGlTextPass.prototype.uploadFrame
WebGlTextPass.prototype.uploadFrame = function (frame, updates) {
  const started = performance.now()
  const operations = glUpload.call(this, frame, updates)
  stats.uploadMs += performance.now() - started
  stats.uploadCalls += 1
  stats.uploadBytes += this.frameUploadedBytes
  stats.uploadOperations += operations
  return operations
}
function records(builder: ZigFrameBuilder) {
  const cells = builder.cellData
  const glyphs = builder.glyphData
  let activeGlyphs = 0
  let activeCells = 0
  for (let offset = 0; offset < glyphs.length; offset += 24)
    activeGlyphs += Number(glyphs[offset + 16] !== 0)
  for (let offset = 0; offset < cells.length; offset += 16)
    activeCells += Number(cells[offset + 3] !== 0)
  return {
    cellHash: hashWords(cells),
    glyphHash: hashWords(glyphs),
    columns: builder.columns,
    rows: builder.rows,
    cellBytes: cells.byteLength,
    glyphBytes: glyphs.byteLength,
    sameMemory: cells.buffer === glyphs.buffer,
    cellByteOffset: cells.byteOffset,
    glyphByteOffset: glyphs.byteOffset,
    wasmMemoryBytes: cells.buffer.byteLength,
    activeCells,
    activeGlyphs,
    glyphIndexEntries: builder.glyphCount,
    stableRows: builder.stableRows,
    rowOffset: builder.rowOffset,
    rowRebuilds: builder.rowRebuilds,
    rowReuses: builder.rowReuses,
    ranges: builder.changedRanges(),
    firstCell: Array.from(cells.subarray(0, 16)),
    firstGlyph: Array.from(glyphs.subarray(0, 24)),
  }
}
Object.assign(window, { __recordProbe: { stats, records: () => Array.from(builders, records) } })
declare global {
  interface Window {
    __recordProbe?: { stats: typeof stats; records(): ReturnType<typeof records>[] }
  }
}

const probeExports: WebAssembly.Exports[] = []
const nativeInstantiate = WebAssembly.instantiate
WebAssembly.instantiate = new Proxy(nativeInstantiate, {
  async apply(target, receiver, args) {
    const [module, imports] = args
    if (!imports?.env?.ghostty_render_state_get) return Reflect.apply(target, receiver, args)
    const result = await Reflect.apply(target, receiver, [
      module,
      { ...imports, env: { ...imports.env, probe_now: performance.now.bind(performance) } },
    ])
    const instance = result instanceof WebAssembly.Instance ? result : result.instance
    if ('bridge_probe_reset' in instance.exports) probeExports.push(instance.exports)
    return result
  },
})
function probeFunction(exports: WebAssembly.Exports, name: string): CallableFunction {
  const value = exports[name]
  if (typeof value !== 'function') throw new Error(`Missing probe export ${name}`)
  return value
}
Object.assign(window, {
  __nativeProbe: {
    reset(repetitions: number) {
      for (const exports of probeExports) probeFunction(exports, 'bridge_probe_reset')(repetitions)
    },
    read() {
      return probeExports.map((exports) => ({
        totals: Array.from({ length: 6 }, (_, index) =>
          Number(probeFunction(exports, 'bridge_probe_get')(index)),
        ),
        counts: Array.from({ length: 6 }, (_, index) =>
          Number(probeFunction(exports, 'bridge_probe_count')(index)),
        ),
      }))
    },
  },
})
declare global {
  interface Window {
    __nativeProbe: {
      reset(repetitions: number): void
      read(): { totals: number[]; counts: number[] }[]
    }
  }
}

function hashWords(values: Float32Array): number {
  const words = new Uint32Array(values.buffer, values.byteOffset, values.length)
  let hash = 2166136261
  for (const word of words) hash = Math.imul(hash ^ word, 16777619) >>> 0
  return hash
}
async function digestRecords() {
  const result = []
  for (const builder of builders) {
    const cell = Uint8Array.from(
      new Uint8Array(
        builder.cellData.buffer,
        builder.cellData.byteOffset,
        builder.cellData.byteLength,
      ),
    )
    const glyph = Uint8Array.from(
      new Uint8Array(
        builder.glyphData.buffer,
        builder.glyphData.byteOffset,
        builder.glyphData.byteLength,
      ),
    )
    result.push({ cell: await digest(cell), glyph: await digest(glyph) })
  }
  return result
}
async function digest(bytes: Uint8Array<ArrayBuffer>) {
  const result = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(result, (value) => value.toString(16).padStart(2, '0')).join('')
}
Object.assign(window, { __recordDigests: digestRecords })
declare global {
  interface Window {
    __recordDigests: typeof digestRecords
  }
}

import { ComparisonTracing } from './comparison-tracing.ts'

export const tracing = new ComparisonTracing()
export const startup = []
const nativeCompile = WebAssembly.compile.bind(WebAssembly)
const nativeInstantiate = WebAssembly.instantiate.bind(WebAssembly)
const allocated = { buffers: [], textures: [] }
const longTasks = []
const timestampReads = []
const timestampEnabled = new URL(location.href).searchParams.has('timestamp')
new PerformanceObserver((list) =>
  longTasks.push(...list.getEntries().map(({ startTime, duration }) => ({ startTime, duration }))),
).observe({ type: 'longtask', buffered: true })
WebAssembly.compile = async (bytes) => {
  const start = performance.now()
  const result = await nativeCompile(bytes)
  startup.push({
    stage: 'compile',
    bytes: bytes.byteLength,
    milliseconds: performance.now() - start,
  })
  return result
}
WebAssembly.instantiate = async (...args) => {
  const start = performance.now()
  const result = await nativeInstantiate(...args)
  startup.push({ stage: 'instantiate', milliseconds: performance.now() - start })
  return result
}
if (globalThis.GPUDevice) {
  const buffer = GPUDevice.prototype.createBuffer
  GPUDevice.prototype.createBuffer = function (descriptor) {
    const result = buffer.call(this, descriptor)
    allocated.buffers.push(result)
    return result
  }
  const texture = GPUDevice.prototype.createTexture
  GPUDevice.prototype.createTexture = function (descriptor) {
    const result = texture.call(this, descriptor)
    allocated.textures.push(result)
    return result
  }
}

export function attachNative(id, runtime, core, state) {
  tracing.native(id, core, state)
  tracing.wrap(runtime.bridge, 'buildFrame', id, 'instances')
  // The bridge callback adds one JS call around the actual wasm export.
  const exports = runtime.bridge.bridgeExports
  runtime.bridge.bridgeExports = { ...exports }
  tracing.wrap(runtime.bridge.bridgeExports, 'bridge_build_frame', id, 'instances')
}

const rasterizers = new WeakSet()
function attachRasterizer(id, renderer) {
  const rasterizer = renderer.rasterizer
  if (!rasterizer || rasterizers.has(rasterizer)) return
  rasterizers.add(rasterizer)
  tracing.wrap(rasterizer, 'rasterize', id, 'js')
  tracing.wrap(rasterizer, 'rasterizeUncached', id, 'js')
}
export function attachRenderer(id, renderer) {
  if (renderer.backend === 'webgpu') tracing.renderer(id, renderer)
  if (timestampEnabled && renderer.backend === 'webgpu') attachTimestamps(renderer.device)
  if (renderer.backend !== 'webgpu') tracing.nativeRenderer(id, renderer)
  if (!renderer.rasterizer) return
  attachRasterizer(id, renderer)
  tracing.wrap(renderer, 'clearTextureAtlas', id, 'js', () => attachRasterizer(id, renderer), true)
  tracing.wrap(renderer, 'setFont', id, 'js', () => attachRasterizer(id, renderer), true)
  tracing.wrap(renderer.atlas, 'getOrInsert', id, 'js')
}

const identities = new Map()
function identity(object) {
  if (object === undefined) return null
  if (!identities.has(object)) identities.set(object, identities.size)
  return identities.get(object)
}
function gpuSnapshot(renderer) {
  if (renderer.backend === 'webgpu') {
    const pass = renderer.textPass
    return {
      backend: renderer.backend,
      device: identity(renderer.device),
      adapter: adapterSnapshot(renderer.device.adapterInfo),
      queue: identity(renderer.device.queue),
      coordinator: identity(renderer.coordinator),
      scheduler: identity(renderer.scheduler),
      pipelines: [
        identity((pass.pipelines ?? pass.resources).cellPipeline),
        identity((pass.pipelines ?? pass.resources).glyphPipeline),
      ],
      buffers: pass.ownedBuffers.map((buffer) => buffer.size),
      textures: Object.values(renderer.atlasTextures.textures).map(({ texture }) => ({
        id: identity(texture),
        width: texture.width,
        height: texture.height,
        layers: texture.depthOrArrayLayers,
        format: texture.format,
      })),
      features: Array.from(renderer.device.features),
      builder: builderSnapshot(renderer.zigBuilder),
    }
  }
  if (renderer.backend !== 'webgl2')
    return { backend: renderer.backend, scheduler: identity(renderer.scheduler) }
  const pass = renderer.state.pass
  if (!pass) return { backend: renderer.backend, state: renderer.state.kind, contextLost: true }
  const gl = pass.context
  if (gl.isContextLost()) return { backend: renderer.backend, context: identity(gl), contextLost: true }
  const buffers = [pass.cells, pass.glyphs].map((pipeline) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, pipeline.buffer)
    return gl.getBufferParameter(gl.ARRAY_BUFFER, gl.BUFFER_SIZE)
  })
  return {
    backend: renderer.backend,
    context: identity(gl),
    contextLost: gl.isContextLost(),
    scheduler: identity(renderer.scheduler),
    pipelines: [identity(pass.cells.program), identity(pass.glyphs.program)],
    buffers,
    atlasLayout: renderer.atlas.textureLayout,
    vendor: gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_VENDOR_WEBGL),
    renderer: gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL),
    timerQuery: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'),
    builder: builderSnapshot(renderer.zigBuilder),
  }
}

function builderSnapshot(builder) {
  if (!builder) return null
  return {
    allocatedBytes: builder.allocations.reduce((sum, item) => sum + item.length, 0),
    cellBytes: builder.cellData.byteLength,
    glyphBytes: builder.glyphData.byteLength,
    glyphCount: builder.glyphCount,
  }
}

export function snapshot(runtime, renderer) {
  return {
    scrollbackRows: runtime.terminals.values().next().value.scrollbackLength,
    rasterizerBitmapBytes: renderer.rasterizer?.bitmapCacheBytes,
    rasterizerEntries: renderer.rasterizer?.bitmaps.size,
    wasmBytes: runtime.exports.memory.buffer.byteLength,
    wasmPages: runtime.exports.memory.buffer.byteLength / 65536,
    bridgeImportsCoreMemory: runtime.bridge.imports.env.memory === runtime.exports.memory,
    gpu: gpuSnapshot(renderer),
    longTasks: longTasks.slice(),
  }
}

export async function completion(renderer) {
  const started = performance.now()
  if (renderer.backend === 'webgpu') await renderer.device.queue.onSubmittedWorkDone()
  if (renderer.backend === 'webgl2') await fence(renderer.state.pass.context)
  const milliseconds = performance.now() - started
  const gpuNanoseconds = await readTimestamps()
  return {
    milliseconds,
    gpuNanoseconds,
    endpoint:
      renderer.backend === 'webgpu' ? 'queue.onSubmittedWorkDone' : 'WebGL fenceSync polling',
  }
}

async function fence(gl) {
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
  gl.flush()
  for (;;) {
    const status = gl.clientWaitSync(sync, 0, 0)
    if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) break
    if (status === gl.WAIT_FAILED) throw new Error('WebGL fence wait failed')
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  gl.deleteSync(sync)
}

const timestampDevices = new WeakSet()
function attachTimestamps(device) {
  if (!device.features.has('timestamp-query') || timestampDevices.has(device)) return
  timestampDevices.add(device)
  const create = device.createCommandEncoder.bind(device)
  device.createCommandEncoder = (...args) => timestampEncoder(device, create(...args))
}
function timestampEncoder(device, encoder) {
    const query = device.createQuerySet({ type: 'timestamp', count: 32 })
    const resolve = device.createBuffer({ size: 256, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC })
    const read = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    let count = 0
    const begin = encoder.beginRenderPass.bind(encoder)
    encoder.beginRenderPass = function (descriptor) {
      const first = count
      count += 2
      return begin({ ...descriptor, timestampWrites: { querySet: query, beginningOfPassWriteIndex: first, endOfPassWriteIndex: first + 1 } })
    }
    const finish = encoder.finish.bind(encoder)
    encoder.finish = function (...finishArgs) {
      if (count) {
        encoder.resolveQuerySet(query, 0, count, resolve, 0)
        encoder.copyBufferToBuffer(resolve, 0, read, 0, count * 8)
      }
      timestampReads.push({ query, resolve, read, count })
      return finish(...finishArgs)
    }
  return encoder
}
async function readTimestamp(entry) {
  if (!entry.count) {
    entry.query.destroy()
    entry.resolve.destroy()
    entry.read.destroy()
    return []
  }
  await entry.read.mapAsync(GPUMapMode.READ)
  const values = new BigUint64Array(entry.read.getMappedRange())
  const durations = []
  for (let index = 0; index < entry.count; index += 2) durations.push(Number(values[index + 1] - values[index]))
  entry.read.unmap()
  entry.query.destroy()
  entry.resolve.destroy()
  entry.read.destroy()
  return durations
}
async function readTimestamps() {
  const reads = timestampReads.splice(0)
  return (await Promise.all(reads.map(readTimestamp))).flat()
}

function adapterSnapshot(info) {
  return {
    vendor: info.vendor,
    architecture: info.architecture,
    device: info.device,
    description: info.description,
    fallback: info.isFallbackAdapter,
    subgroupMinSize: info.subgroupMinSize,
    subgroupMaxSize: info.subgroupMaxSize,
  }
}

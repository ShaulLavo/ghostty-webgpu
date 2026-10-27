interface UploadTarget {
  readonly adapter: unknown
  write(offset: number, bytes: Uint8Array): void
  finish(): Promise<void>
  dispose(): void
}

async function target(backend: string, size: number): Promise<UploadTarget> {
  if (backend === 'webgpu') {
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter || adapter.info.isFallbackAdapter) throw new Error('Hardware WebGPU required')
    const device = await adapter.requestDevice()
    const buffer = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST })
    return {
      adapter: {
        vendor: adapter.info.vendor,
        device: adapter.info.device,
        description: adapter.info.description,
        architecture: adapter.info.architecture,
        fallback: adapter.info.isFallbackAdapter,
      },
      write: (offset, bytes) => device.queue.writeBuffer(buffer, offset, bytes),
      finish: () => device.queue.onSubmittedWorkDone(),
      dispose: () => {
        buffer.destroy()
        device.destroy()
      },
    }
  }
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2')
  if (!gl) throw new Error('WebGL2 required')
  const info = gl.getExtension('WEBGL_debug_renderer_info')
  const adapter = info
    ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER)
  if (/swiftshader|llvmpipe|software/i.test(String(adapter)))
    throw new Error('Hardware WebGL2 required')
  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, size, gl.DYNAMIC_DRAW)
  return {
    adapter,
    write: (offset, bytes) => gl.bufferSubData(gl.ARRAY_BUFFER, offset, bytes),
    finish: async () => {
      gl.finish()
    },
    dispose: () => {
      gl.deleteBuffer(buffer)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}

export async function createSweep(backend: string) {
  const gpu = await target(backend, 1600064)
  return {
    adapter: gpu.adapter,
    measure: (gap: number, mode: string) => measure(gpu, gap, mode),
    dispose: () => gpu.dispose(),
  }
}

async function measure(gpu: UploadTarget, gap: number, mode: string) {
  const source = new Uint8Array(gap + 128)
  source.fill(17, 0, 64)
  source.fill(29, gap + 64)
  const first = source.subarray(0, 64)
  const last = source.subarray(gap + 64)
  const iterations = 300
  await gpu.finish()
  const started = performance.now()
  for (let index = 0; index < iterations; index += 1) {
    if (mode === 'bound') {
      gpu.write(0, source)
      continue
    }
    gpu.write(0, first)
    gpu.write(gap + 64, last)
  }
  const callMilliseconds = performance.now() - started
  await gpu.finish()
  return {
    mode,
    callMilliseconds,
    completedMilliseconds: performance.now() - started,
    iterations,
    calls: iterations * (mode === 'bound' ? 1 : 2),
    bytes: iterations * (mode === 'bound' ? source.length : 128),
  }
}

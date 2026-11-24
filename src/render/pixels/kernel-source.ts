import { runtimeWasmAssets } from '../../core/assets.js'
import { createGhosttyError } from '../../core/error.js'

export const canvasWasmAssets = {
  canvasCompose: runtimeWasmAssets.canvasCompose,
  canvasComposeScalar: runtimeWasmAssets.canvasComposeScalar,
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

export function loadComposeKernelBytes(source: string | URL): Promise<ArrayBuffer> {
  if (prefetch?.source !== source) return compositorAssetBytes(source)
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

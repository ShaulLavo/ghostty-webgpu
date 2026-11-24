import type { WorkerAssets } from './protocol.js'

export interface CompiledWorkerModules {
  readonly wasm: WebAssembly.Module
  readonly bridge: WebAssembly.Module
}

function networkUrl(value: string): URL | undefined {
  if (!URL.canParse(value)) return undefined
  const url = new URL(value)
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined
}

async function compile(url: URL): Promise<WebAssembly.Module> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return WebAssembly.compileStreaming(response)
}

/**
 * Starts the wasm download on the page so it overlaps the worker script download.
 * Relative asset URLs resolve against the worker module, so only absolute ones qualify.
 */
export function compileWorkerModules(
  assets: WorkerAssets,
): Promise<CompiledWorkerModules> | undefined {
  const wasm = networkUrl(assets.wasm)
  const bridge = networkUrl(assets.bridge)
  if (!wasm || !bridge || typeof WebAssembly.compileStreaming !== 'function') return undefined
  return Promise.all([compile(wasm), compile(bridge)]).then(([wasm, bridge]) => ({ wasm, bridge }))
}

export const runtimeWasmAssets = {
  native: new URL('../../ghostty-vt.wasm', import.meta.url),
  bridge: new URL('../../bridge.wasm', import.meta.url),
  canvasCompose: new URL('../../canvas-compose.wasm', import.meta.url),
} as const

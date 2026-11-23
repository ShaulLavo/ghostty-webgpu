export const terminalWasmAssets = {
  native: /* @__PURE__ */ new URL('../../ghostty-vt.wasm', import.meta.url),
  bridge: /* @__PURE__ */ new URL('../../bridge.wasm', import.meta.url),
} as const

/** Every runtime wasm file the package ships. The Canvas kernel declares its own copies. */
export const runtimeWasmAssets = {
  ...terminalWasmAssets,
  canvasCompose: /* @__PURE__ */ new URL('../../canvas-compose.wasm', import.meta.url),
  canvasComposeScalar: /* @__PURE__ */ new URL('../../canvas-compose-scalar.wasm', import.meta.url),
} as const

import type { AbiLayouts, BridgeWasmExports, GhosttyWasmExports } from './abi.js'
import { CallbackBridge } from './bridge.js'
import { createGhosttyError } from './error.js'
import { parseAbiLayouts, WasmMemory } from './memory.js'
import { GhosttyRenderState } from './render-state.js'
import { GhosttyTerminal } from './terminal.js'
import type { DecodedPng, RuntimeOptions, TerminalOptions, WasmSource } from './types.js'

const defaultWasm = new URL('../../ghostty-vt.wasm', import.meta.url)
const defaultBridge = new URL('../../bridge.wasm', import.meta.url)

async function readFileUrl(url: URL): Promise<ArrayBuffer> {
  try {
    const { readFile } = await import('node:fs/promises')
    const bytes = await readFile(url)
    return Uint8Array.from(bytes).buffer
  } catch (cause) {
    throw createGhosttyError('wasm.read', `Unable to read wasm artifact at ${url.href}`, cause)
  }
}

async function fetchBytes(url: URL): Promise<ArrayBuffer> {
  let response: Response
  try {
    response = await fetch(url)
  } catch (cause) {
    throw createGhosttyError('wasm.fetch', `Unable to fetch wasm artifact at ${url.href}`, cause)
  }
  if (response.ok) return response.arrayBuffer()
  throw createGhosttyError(
    'wasm.fetch',
    `Unable to fetch wasm artifact at ${url.href}: ${response.status} ${response.statusText}`,
  )
}

function resolveUrl(source: URL | string): URL {
  if (source instanceof URL) return source
  return new URL(source, import.meta.url)
}

async function compileSource(source: WasmSource): Promise<WebAssembly.Module> {
  if (source instanceof WebAssembly.Module) return source
  if (source instanceof ArrayBuffer) return WebAssembly.compile(source)
  if (ArrayBuffer.isView(source)) {
    const bytes = Uint8Array.from(
      new Uint8Array(source.buffer, source.byteOffset, source.byteLength),
    )
    return WebAssembly.compile(bytes)
  }
  const url = resolveUrl(source)
  const bytes = url.protocol === 'file:' ? await readFileUrl(url) : await fetchBytes(url)
  return WebAssembly.compile(bytes)
}

function validateExports(exports: WebAssembly.Exports): GhosttyWasmExports {
  const required = [
    'memory',
    '__indirect_function_table',
    'ghostty_cell_get',
    'ghostty_terminal_get',
    'ghostty_terminal_new',
    'ghostty_terminal_vt_write',
    'ghostty_render_state_update',
    'ghostty_sys_set',
  ]
  for (const name of required) {
    if (name in exports) continue
    throw createGhosttyError('wasm.instantiate', `libghostty-vt export is missing: ${name}`)
  }
  return exports as GhosttyWasmExports
}

export class GhosttyRuntime {
  readonly bridge: CallbackBridge
  readonly exports: GhosttyWasmExports
  readonly layouts: AbiLayouts
  readonly memory: WasmMemory
  private readonly renderStates = new Set<GhosttyRenderState>()
  private readonly terminals = new Set<GhosttyTerminal>()
  private disposed = false

  private constructor(exports: GhosttyWasmExports, bridge: CallbackBridge, layouts: AbiLayouts) {
    this.exports = exports
    this.bridge = bridge
    this.layouts = layouts
    this.memory = new WasmMemory(exports)
  }

  static async create(options: RuntimeOptions = {}): Promise<GhosttyRuntime> {
    const [wasmModule, bridgeModule] = await Promise.all([
      compileSource(options.wasm ?? defaultWasm),
      compileSource(options.bridge ?? defaultBridge),
    ])
    let wasmExports: GhosttyWasmExports | undefined
    const wasmInstance = await WebAssembly.instantiate(wasmModule, {
      env: {
        log: (pointer: number, length: number) => {
          if (!wasmExports || !options.log) return
          const bytes = new Uint8Array(wasmExports.memory.buffer, pointer, length)
          options.log(new TextDecoder().decode(bytes))
        },
      },
    })
    wasmExports = validateExports(wasmInstance.exports)
    const memory = new WasmMemory(wasmExports)
    const layouts = parseAbiLayouts(memory)
    const bridge = new CallbackBridge(wasmExports, layouts)
    const bridgeInstance = await WebAssembly.instantiate(bridgeModule, bridge.imports)
    bridge.install(bridgeInstance.exports as BridgeWasmExports)
    const runtime = new GhosttyRuntime(wasmExports, bridge, layouts)
    if (options.decodePng) runtime.configurePngDecoder(options.decodePng)
    return runtime
  }

  createTerminal(options: TerminalOptions = {}): GhosttyTerminal {
    this.ensureActive()
    const terminal = new GhosttyTerminal(this, options)
    this.terminals.add(terminal)
    return terminal
  }

  createRenderState(terminal: GhosttyTerminal): GhosttyRenderState {
    this.ensureActive()
    if (terminal.runtime !== this) {
      throw createGhosttyError('render_state.new', 'The terminal belongs to a different runtime')
    }
    const renderState = new GhosttyRenderState(this, terminal)
    this.renderStates.add(renderState)
    return renderState
  }

  configurePngDecoder(decoder?: (bytes: Uint8Array) => DecodedPng | undefined): void {
    this.ensureActive()
    if (this.bridge.terminalCount > 0) {
      throw createGhosttyError(
        'ghostty_sys_set(DECODE_PNG)',
        'PNG decoding must be configured before the first terminal is created',
      )
    }
    this.bridge.configurePngDecoder(decoder)
  }

  dispose(): void {
    if (this.disposed) return
    for (const renderState of this.renderStates) renderState.dispose()
    for (const terminal of this.terminals) terminal.dispose()
    this.bridge.configurePngDecoder(undefined)
    this.disposed = true
  }

  releaseRenderState(renderState: GhosttyRenderState): void {
    this.renderStates.delete(renderState)
  }

  releaseTerminal(terminal: GhosttyTerminal): void {
    this.terminals.delete(terminal)
  }

  ensureActive(): void {
    if (!this.disposed) return
    throw createGhosttyError('runtime', 'The Ghostty runtime has been disposed')
  }
}

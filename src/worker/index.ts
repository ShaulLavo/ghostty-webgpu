import { runtimeWasmAssets } from '../core/assets.js'
import { Terminal as TerminalHost } from '../dom/terminal.js'
import type { GhosttyWebGpuTerminalFromSessionOptions } from '../dom/types.js'
import { WorkerTerminalExecution } from './execution.js'
import type { WorkerAssets, WorkerBackend, WorkerFontFace } from './protocol.js'

export interface WorkerTerminalOptions extends Omit<
  GhosttyWebGpuTerminalFromSessionOptions,
  'elements' | 'fitEnvironment' | 'rendererFactory' | 'runtime'
> {
  readonly assets?: WorkerAssets
  readonly backend?: WorkerBackend
  readonly fonts: readonly WorkerFontFace[]
  readonly workerUrl?: string | URL
}
export type Terminal = TerminalHost<'async'>

/** The same DOM host, with asynchronous native authority in one dedicated execution actor. */
export const Terminal = Object.freeze({
  async create(options: WorkerTerminalOptions): Promise<Terminal> {
    const appearance = {
      ...options.appearance,
      font: {
        ...options.appearance?.font,
        family: options.appearance?.font?.family ?? options.fonts[0]?.family,
      },
    }
    const execution = await WorkerTerminalExecution.create({
      assets: options.assets ?? {
        wasm: runtimeWasmAssets.native.href,
        bridge: runtimeWasmAssets.bridge.href,
      },
      backend: options.backend ?? 'auto',
      faces: options.fonts,
      appearance,
      links: options.links,
      workerUrl: options.workerUrl,
    })
    try {
      return TerminalHost.fromWorker(execution, options)
    } catch (cause) {
      await execution.dispose()
      throw cause
    }
  },
})
export { TerminalWorkerError } from './structured-errors.js'
export type { TerminalApi, TerminalResult } from '../dom/terminal-api.js'
export type { TerminalSubmittedFrame } from '../dom/submitted-frame.js'
export type {
  TerminalOutputMessage,
  TerminalOutputReady,
  TerminalOutputAck,
  WorkerAssets,
  WorkerBackend,
  WorkerFontFace,
} from './protocol.js'

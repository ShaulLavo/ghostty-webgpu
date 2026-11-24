import {
  createCompatibleTerminalRenderer,
  prewarmCompatibleRenderer,
} from '../render/shared/selector.js'
import type { TerminalSession } from '../term/session.js'
import type { WorkerTerminalExecution } from '../worker/execution.js'
import { LocalTerminalExecution } from './execution-local.js'
import { TerminalHost } from './terminal-host.js'
import type {
  GhosttyWebGpuTerminalFromSessionOptions,
  GhosttyWebGpuTerminalOptions,
} from './types.js'

const createFromSessionInternal = Symbol('createFromSessionInternal')

export class Terminal<Mode extends 'sync' | 'async' = 'sync'> extends TerminalHost<Mode> {
  // Preserve `workerTerminal instanceof Terminal` without making the worker entry import local execution.
  static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof TerminalHost
  }

  private constructor(
    execution: LocalTerminalExecution | WorkerTerminalExecution,
    options: GhosttyWebGpuTerminalFromSessionOptions,
  ) {
    super(execution, options, createCompatibleTerminalRenderer)
  }

  static override fromWorker(
    execution: WorkerTerminalExecution,
    options: GhosttyWebGpuTerminalFromSessionOptions,
  ): Terminal<'async'> {
    return new Terminal<'async'>(execution, options)
  }

  static async create(options: GhosttyWebGpuTerminalOptions = {}): Promise<Terminal> {
    // Renderer chunks download while the wasm core compiles, not after it.
    if (!options.rendererFactory) prewarmCompatibleRenderer(options)
    const execution = await LocalTerminalExecution.create({
      appearance: options.appearance,
      links: options.links,
      runtime: options.runtime,
      bidi: options.bidi,
    })
    try {
      return new Terminal(execution, options)
    } catch (cause) {
      execution.dispose()
      throw cause
    }
  }

  static [createFromSessionInternal](
    session: TerminalSession<Event>,
    options: GhosttyWebGpuTerminalFromSessionOptions = {},
  ): Terminal {
    try {
      return new Terminal(new LocalTerminalExecution(session), options)
    } catch (cause) {
      options.elements?.dispose()
      session.dispose()
      throw cause
    }
  }
}

export function createGhosttyWebGpuTerminalFromSession(
  session: TerminalSession<Event>,
  options: GhosttyWebGpuTerminalFromSessionOptions = {},
): Terminal {
  return Terminal[createFromSessionInternal](session, options)
}

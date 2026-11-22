import { createCompatibleTerminalRenderer } from '../render/shared/selector.js'
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

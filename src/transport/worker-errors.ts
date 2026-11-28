import { GhosttyError } from '../core/error.js'

const catalog = {
  capability: {
    status: 501,
    why: 'The browser cannot run the requested terminal worker.',
    fix: 'Use a browser with the selected worker renderer.',
  },
  startup: {
    status: 500,
    why: 'The terminal worker could not start.',
    fix: 'Check the worker, native asset and font URLs.',
  },
  protocol: {
    status: 500,
    why: 'The terminal worker received an invalid message.',
    fix: 'Create a new terminal with matching package assets.',
  },
  timeout: {
    status: 504,
    why: 'The terminal worker did not acknowledge an operation.',
    fix: 'Check the output producer and create a new terminal.',
  },
  disposed: {
    status: 410,
    why: 'The terminal execution has ended.',
    fix: 'Create a new terminal to continue.',
  },
  execution: {
    status: 500,
    why: 'The terminal worker could not complete an operation.',
    fix: 'Check the native assets and create a new terminal.',
  },
} as const
export type WorkerErrorCode = keyof typeof catalog
export interface WorkerFailure {
  readonly code: WorkerErrorCode
  readonly operation: string
  readonly status: number
  readonly why: string
  readonly fix: string
  readonly internal: Readonly<Record<string, number | string | boolean | undefined>>
}
export class TerminalWorkerError extends GhosttyError {
  readonly code: WorkerErrorCode
  readonly status: number
  readonly why: string
  readonly fix: string
  readonly internal: WorkerFailure['internal']
  constructor(failure: WorkerFailure) {
    super(failure.why, { operation: failure.operation })
    this.name = 'TerminalWorkerError'
    this.code = failure.code
    this.status = failure.status
    this.why = failure.why
    this.fix = failure.fix
    this.internal = failure.internal
  }
}
function workerFailure(
  code: WorkerErrorCode,
  operation: string,
  internal: WorkerFailure['internal'],
): WorkerFailure {
  return { code, operation, ...catalog[code], internal }
}
export function workerError(
  code: WorkerErrorCode,
  operation: string,
  internal: WorkerFailure['internal'],
): TerminalWorkerError {
  return new TerminalWorkerError(workerFailure(code, operation, internal))
}
export function serializeWorkerFailure(cause: unknown, operation: string): WorkerFailure {
  if (cause instanceof TerminalWorkerError)
    return workerFailure(cause.code, cause.operation, cause.internal)
  if (cause instanceof GhosttyError)
    return workerFailure('execution', operation, {
      causeType: cause.name,
      causeOperation: cause.operation,
      causeResult: cause.result,
    })
  return workerFailure('execution', operation, {
    causeType: cause instanceof Error ? cause.name : typeof cause,
  })
}

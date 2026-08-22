import { GhosttyResult } from './abi.js'

const resultNames: Readonly<Record<number, string>> = {
  [GhosttyResult.Success]: 'success',
  [GhosttyResult.OutOfMemory]: 'out of memory',
  [GhosttyResult.InvalidValue]: 'invalid value',
  [GhosttyResult.OutOfSpace]: 'out of space',
  [GhosttyResult.NoValue]: 'no value',
  [GhosttyResult.IoError]: 'I/O error',
  [GhosttyResult.LimitExceeded]: 'limit exceeded',
}

export class GhosttyError extends Error {
  readonly operation: string
  readonly result?: number

  constructor(message: string, options: { cause?: unknown; operation: string; result?: number }) {
    super(message, { cause: options.cause })
    this.name = 'GhosttyError'
    this.operation = options.operation
    this.result = options.result
  }
}

export function assertGhosttyResult(operation: string, result: number): void {
  if (result === GhosttyResult.Success) return
  const name = resultNames[result] ?? 'unknown result'
  throw new GhosttyError(`${operation} failed: ${name} (${result})`, { operation, result })
}

export function createGhosttyError(
  operation: string,
  message: string,
  cause?: unknown,
): GhosttyError {
  return new GhosttyError(message, { cause, operation })
}

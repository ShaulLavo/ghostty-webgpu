import { GhosttyResult } from './abi.js'
import { assertGhosttyResult, createGhosttyError } from './error.js'
import type { GhosttyRuntime } from './runtime.js'

type NativeBufferReader = (buffer: number, length: number, outWritten: number) => number

export function readNativeBuffer(
  runtime: GhosttyRuntime,
  operation: string,
  read: NativeBufferReader,
): Uint8Array | undefined {
  const outWritten = runtime.memory.allocate(4)
  try {
    const result = read(0, 0, outWritten)
    if (result === GhosttyResult.NoValue) return undefined
    if (result === GhosttyResult.Success) return new Uint8Array()
    if (result !== GhosttyResult.OutOfSpace) assertGhosttyResult(operation, result)
    const required = runtime.memory.view.getUint32(outWritten, true)
    return readAllocatedBuffer(runtime, operation, required, outWritten, read)
  } finally {
    runtime.memory.free(outWritten, 4)
  }
}

function readAllocatedBuffer(
  runtime: GhosttyRuntime,
  operation: string,
  required: number,
  outWritten: number,
  read: NativeBufferReader,
): Uint8Array {
  if (required === 0) return new Uint8Array()
  const buffer = runtime.memory.allocate(required)
  try {
    assertGhosttyResult(operation, read(buffer, required, outWritten))
    const written = runtime.memory.view.getUint32(outWritten, true)
    if (written <= required)
      return Uint8Array.from(runtime.memory.bytes.subarray(buffer, buffer + written))
    throw createGhosttyError(operation, `Native call wrote ${written} bytes into ${required}`)
  } finally {
    runtime.memory.free(buffer, required)
  }
}

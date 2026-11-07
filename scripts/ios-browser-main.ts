import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import {
  NativePreconditionError,
  nativePreflight,
  nativeUsage,
  parseNativeArguments,
} from './ios-browser-options.ts'

export async function nativeWorker(args: readonly string[]): Promise<number> {
  try {
    const request = parseNativeArguments(args)
    if (request.kind === 'help') {
      console.log(nativeUsage)
      return 0
    }
    await nativePreflight(request.options)
    const { executeNativeStage } = await import('./ios-browser-run.ts')
    return await executeNativeStage(request.options)
  } catch (error) {
    console.error(error)
    return error instanceof NativePreconditionError ? 3 : 2
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  process.exitCode = await nativeWorker(process.argv.slice(2))

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import {
  nativePreflight,
  nativeUsage,
  NativePreconditionError,
  parseNativeArguments,
} from './ios-browser-options.ts'
import { runNodeProcess } from './ios-browser-process.ts'
import { launcherReceipt } from './ios-browser-result.ts'

export async function nativeLauncher(args: readonly string[]): Promise<number> {
  try {
    const request = parseNativeArguments(args)
    if (request.kind === 'help') {
      console.log(nativeUsage)
      return 0
    }
    await nativePreflight(request.options)
    const interrupt = new AbortController()
    const stop = () => interrupt.abort()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    try {
      const { stage, udid, resultPath } = request.options
      const outcome = await runNodeProcess({
        script: fileURLToPath(new URL('./ios-browser-main.ts', import.meta.url)),
        args: ['--stage', stage, '--udid', udid, '--result', resultPath],
        cwd: fileURLToPath(new URL('../', import.meta.url)),
        signal: interrupt.signal,
      })
      return await launcherReceipt(resultPath, outcome)
    } finally {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
    }
  } catch (error) {
    console.error(error)
    return error instanceof NativePreconditionError ? 3 : 2
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  process.exitCode = await nativeLauncher(process.argv.slice(2))

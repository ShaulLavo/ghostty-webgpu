import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NativeContractError } from './config-resolver-native/canonical'
import {
  verifyNativeRepositoryState,
  type NativeRepositoryState,
} from './config-resolver-native/state'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

try {
  const required = parseArguments(process.argv.slice(2))
  const state = verifyNativeRepositoryState(repositoryRoot, required)
  process.stdout.write(`${state}\n`)
} catch (error) {
  // Contract errors carry fixed, path-free reasons; anything else stays opaque.
  const reason = error instanceof NativeContractError ? `: ${error.message}` : ''
  process.stderr.write(`config resolver artifact verification failed${reason}\n`)
  process.exitCode = 1
}

function parseArguments(argv: readonly string[]): NativeRepositoryState | 'either' {
  if (argv.length !== 2 || argv[0] !== '--state') throw new Error('invalid arguments')
  if (argv[1] === 'bootstrap' || argv[1] === 'assembled' || argv[1] === 'either') return argv[1]
  throw new Error('invalid state')
}

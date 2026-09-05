import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalObjectBytes, NativeContractError } from './canonical'
import { NATIVE_INPUTS_PATH } from './constants'
import { createNativeInputs } from './inputs'

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const output = join(repositoryRoot, NATIVE_INPUTS_PATH)
if (process.argv.length !== 3 || process.argv[2] !== '--write') {
  throw new NativeContractError('usage: generate-native-inputs.ts --write')
}
writeFileSync(output, canonicalObjectBytes(createNativeInputs(repositoryRoot)), {
  flag: 'w',
  mode: 0o644,
})
process.stdout.write(`${NATIVE_INPUTS_PATH}\n`)

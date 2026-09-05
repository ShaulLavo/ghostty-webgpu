import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalObjectBytes, NativeContractError } from './canonical'
import { nativeProtocolGoldenPayload } from './native-golden'

const scriptRoot = dirname(fileURLToPath(import.meta.url))
const output = join(scriptRoot, 'fixtures/native-protocol/canonical-ready.json')
const mode = process.argv[2]
if (process.argv.length !== 3 || (mode !== '--check' && mode !== '--write')) {
  throw new NativeContractError('usage: generate-native-golden.ts --check|--write')
}

const value = nativeProtocolGoldenPayload()
const bytes = canonicalObjectBytes(value)
if (mode === '--write') {
  writeFileSync(output, bytes, { flag: 'w', mode: 0o644 })
  process.stdout.write(`${output}\n`)
} else if (!existsSync(output) || !readFileSync(output).equals(bytes)) {
  throw new NativeContractError('native protocol golden fixture is stale')
}

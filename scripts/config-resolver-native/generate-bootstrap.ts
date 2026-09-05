import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalObjectBytes, NativeContractError } from './canonical'
import {
  NATIVE_BOOTSTRAP_PATH,
  NATIVE_PACKAGE_VERSION,
  NATIVE_TARGETS,
  NATIVE_UPSTREAM_REVISION,
} from './constants'
import { validateNativeBootstrap } from './contract'
import { verifyNativeInputs } from './inputs'

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

if (process.argv.length !== 3 || process.argv[2] !== '--write') {
  throw new NativeContractError('usage: generate-bootstrap.ts --write')
}

const inputs = verifyNativeInputs(repositoryRoot)
const bootstrap = validateNativeBootstrap({
  schemaVersion: 1,
  packageVersion: NATIVE_PACKAGE_VERSION,
  upstreamRevision: NATIVE_UPSTREAM_REVISION,
  targets: NATIVE_TARGETS,
  nativeInputsTreeSha256: inputs.sha256,
})
const output = join(repositoryRoot, NATIVE_BOOTSTRAP_PATH)
prepareBootstrapRoot(dirname(output))
assertWritableMarker(output)
writeFileSync(output, canonicalObjectBytes(bootstrap), { flag: 'w', mode: 0o644 })
process.stdout.write(`${NATIVE_BOOTSTRAP_PATH}\n`)

function prepareBootstrapRoot(root: string): void {
  const nativeRoot = dirname(root)
  ensureDirectory(nativeRoot)
  ensureDirectory(root)
  const entries = readdirSync(root, { encoding: 'utf8' })
  if (entries.some((entry) => entry !== 'bootstrap.json')) {
    throw new NativeContractError('native resolver root is not bootstrap-only')
  }
}

function ensureDirectory(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { mode: 0o755 })
    return
  }
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new NativeContractError('native resolver parent is not a real directory')
  }
}

function assertWritableMarker(path: string): void {
  if (!existsSync(path)) return
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new NativeContractError('bootstrap marker is not a regular file')
  }
}

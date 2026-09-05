import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseReleaseProvenanceArguments,
  runReleaseProvenanceArguments,
} from './release-candidate/provenance-cli'

const SUCCESS = 'release-provenance: PASS\n'
const FAILURE = 'release-provenance: FAIL\n'

export function releaseProvenanceMain(
  argv: readonly string[],
  repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
): number {
  try {
    const arguments_ = parseReleaseProvenanceArguments(argv, repositoryRoot)
    runReleaseProvenanceArguments(arguments_)
    process.stdout.write(SUCCESS)
    return 0
  } catch {
    process.stderr.write(FAILURE)
    return 1
  }
}

if (import.meta.main) process.exitCode = releaseProvenanceMain(process.argv.slice(2))

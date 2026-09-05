import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseReleaseCandidateArguments,
  runReleaseCandidateArguments,
} from './release-candidate/cli'

const SUCCESS = 'release-candidate: PASS\n'
const FAILURE = 'release-candidate: FAIL\n'

export function releaseCandidateMain(
  argv: readonly string[],
  repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
): number {
  try {
    const arguments_ = parseReleaseCandidateArguments(argv, repositoryRoot)
    runReleaseCandidateArguments(arguments_)
    process.stdout.write(SUCCESS)
    return 0
  } catch {
    process.stderr.write(FAILURE)
    return 1
  }
}

if (import.meta.main) process.exitCode = releaseCandidateMain(process.argv.slice(2))

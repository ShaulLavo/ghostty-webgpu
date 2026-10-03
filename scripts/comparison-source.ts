import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function comparisonSourceHash(root: string, runtimeRef?: string) {
  if (runtimeRef) return undefined
  const paths = execFileSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
      'src',
      'bench',
      'scripts/comparison*',
      'scripts/build-comparison.ts',
    ],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean)
  const hash = createHash('sha256')
  for (const path of [...new Set(paths)].sort()) {
    hash.update(path).update('\0')
    hash.update(await readFile(join(root, path))).update('\0')
  }
  return hash.digest('hex')
}

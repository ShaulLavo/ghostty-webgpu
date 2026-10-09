import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { checkoutFiles } from '../bench/comparison-build'

export async function comparisonSourceHash(root: string, runtimeRef?: string) {
  if (runtimeRef) return undefined
  const paths = checkoutFiles(root, [
    'src',
    'bench',
    'scripts/comparison*',
    'scripts/build-comparison.ts',
  ])
  const hash = createHash('sha256')
  for (const path of [...new Set(paths)].sort()) {
    hash.update(path).update('\0')
    hash.update(await readFile(join(root, path))).update('\0')
  }
  return hash.digest('hex')
}

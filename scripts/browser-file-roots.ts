import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { searchForWorkspaceRoot } from 'vite'

export function browserFileRoots(packageDirectory: string): string[] {
  const require = createRequire(path.join(packageDirectory, 'package.json'))
  const stylesheet = realpathSync(require.resolve('@xterm/xterm/css/xterm.css'))
  return [searchForWorkspaceRoot(packageDirectory), stylesheet]
}

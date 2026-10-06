import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { searchForWorkspaceRoot, type Plugin, type ViteDevServer } from 'vite'

export function browserFileRoots(packageDirectory: string): string[] {
  const require = createRequire(path.join(packageDirectory, 'package.json'))
  const stylesheet = realpathSync(require.resolve('@xterm/xterm/css/xterm.css'))
  return [searchForWorkspaceRoot(packageDirectory), stylesheet]
}

export function counterpartWasmServing(): Plugin {
  let server: ViteDevServer | undefined
  return {
    name: 'ghostty-counterpart-wasm',
    apply: 'serve',
    enforce: 'pre',
    configureServer(instance) {
      server = instance
    },
    async resolveId(id, importer) {
      if (id !== 'ghostty-web/ghostty-vt.wasm?url') return
      const resolved = await this.resolve(id, importer, { skipSelf: true })
      if (!resolved || !server) return resolved
      const file = realpathSync(resolved.id.split('?')[0] ?? resolved.id)
      const allowed = server.config.server.fs.allow
      if (!allowed.includes(file)) allowed.push(file)
      return resolved
    },
  }
}

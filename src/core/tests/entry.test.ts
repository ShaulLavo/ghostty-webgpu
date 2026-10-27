import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { GhosttyRuntime } from '../runtime.js'
import { GhosttyTerminal } from '../terminal.js'
import { TerminalSession } from '../../term/session.js'

async function verifyRuntimeGraph(entry: URL): Promise<void> {
  const pending = [entry]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const current = pending.pop()!
    if (visited.has(current.href)) continue
    visited.add(current.href)
    expect(current.pathname).not.toMatch(/\/(dom|render)\//)
    const source = await readFile(current, 'utf8')
    const imports = source.matchAll(
      /\b(?:import|export)\s+(?!type\b)(?:[^;]*?\s+from\s+)?['"](\.[^'"]+)['"]/g,
    )
    for (const match of imports) {
      const dependency = new URL(match[1]!, current)
      if (dependency.pathname.endsWith('.js')) {
        dependency.pathname = dependency.pathname.replace(/\.js$/, '.ts')
      }
      pending.push(dependency)
    }
  }
}

it('exports a headless core entry without DOM or renderer runtime imports', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
  ) as { readonly exports: Record<string, { readonly import: string }> }
  expect(manifest.exports['./core']?.import).toBe('./dist/core/index.js')
  await verifyRuntimeGraph(new URL('../index.ts', import.meta.url))
  const core = await import('../index.js')
  expect(core.GhosttyRuntime).toBe(GhosttyRuntime)
  expect(core.GhosttyTerminal).toBe(GhosttyTerminal)
  expect(core.TerminalSession).toBe(TerminalSession)
})

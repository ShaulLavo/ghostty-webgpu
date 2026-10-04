import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { isFileServingAllowed, resolveConfig, searchForWorkspaceRoot } from 'vite'
import { expect, test } from 'vitest'
import { browserFileRoots } from './browser-file-roots'

test.each(['hoisted', 'standalone'])(
  'adds the declared stylesheet to the existing root for a %s install',
  async (layout) => {
    const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'ghostty-browser-roots-')))
    const family = path.join(directory, 'packages', 'terminal')
    const install = layout === 'hoisted' ? directory : family
    const dependency = path.join(
      install,
      'node_modules',
      '.bun',
      'xterm',
      'node_modules',
      '@xterm',
      'xterm',
    )
    const stylesheet = path.join(dependency, 'css', 'xterm.css')
    const neighbor = path.join(dependency, 'css', 'neighbor.css')
    mkdirSync(family, { recursive: true })
    mkdirSync(path.dirname(stylesheet), { recursive: true })
    mkdirSync(path.join(install, 'node_modules', '@xterm'), { recursive: true })
    writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*'] }),
    )
    writeFileSync(
      path.join(family, 'package.json'),
      JSON.stringify({ workspaces: { packages: [], catalog: {} } }),
    )
    writeFileSync(path.join(dependency, 'package.json'), JSON.stringify({ name: '@xterm/xterm' }))
    writeFileSync(stylesheet, '.xterm {}')
    writeFileSync(neighbor, '.neighbor {}')
    symlinkSync(dependency, path.join(install, 'node_modules', '@xterm', 'xterm'), 'junction')
    try {
      const roots = browserFileRoots(family)
      expect(roots).toEqual([searchForWorkspaceRoot(family), stylesheet])
      const config = await resolveConfig(
        { configFile: false, root: family, server: { fs: { allow: roots } } },
        'serve',
      )
      expect(isFileServingAllowed(config, stylesheet)).toBe(true)
      expect(isFileServingAllowed(config, neighbor)).toBe(layout === 'standalone')
      expect(roots).not.toContain(dependency)
      expect(roots).not.toContain(directory)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  },
)

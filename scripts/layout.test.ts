import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

it('keeps backend implementations and shared contracts in named renderer folders', () => {
  const render = resolve(root, 'src/render')
  expect(readdirSync(render).filter((name) => name.endsWith('.ts'))).toEqual([])
  for (const folder of ['webgpu', 'webgl', 'canvas', 'pixels', 'dom', 'shaders', 'shared']) {
    expect(existsSync(resolve(render, folder))).toBe(true)
  }
  expect(existsSync(resolve(render, 'shared/types.ts'))).toBe(true)
})

it('includes the optional line editor in the standalone workspace', () => {
  const family = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  const editor = JSON.parse(
    readFileSync(resolve(root, 'packages/line-editor/package.json'), 'utf8'),
  )
  expect(family.workspaces.packages).toContain('packages/*')
  expect(editor.name).toBe('ghostty-webgpu-line-editor')
  expect(editor.peerDependenciesMeta['ghostty-webgpu'].optional).toBe(true)
  expect(editor.peerDependencies['ghostty-webgpu']).toBe('^0.3.28')
})

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'vitest'

const scripts = fileURLToPath(new URL('.', import.meta.url))

test('authoritative native command augmentation coexists with desktop insertText', async () => {
  const scratch = await mkdtemp(join(scripts, '.ios-command-types-'))
  try {
    const original = await readFile(join(scripts, 'ios-browser.ts'), 'utf8')
    const source = join(scratch, 'provider.ts')
    await writeFile(
      join(scratch, 'desktop.d.ts'),
      await readFile(join(scripts, 'fixtures/ios-browser/desktop-command-types.d.ts')),
    )
    await writeFile(
      join(scratch, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2023',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          lib: ['ES2024', 'DOM'],
          strict: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          skipLibCheck: true,
          noUncheckedIndexedAccess: true,
          types: ['node'],
        },
        files: ['provider.ts', 'desktop.d.ts', 'coexistence.ts'],
      }),
    )
    await writeFile(
      join(scratch, 'coexistence.ts'),
      "const native: keyof import('vitest/browser').BrowserCommands = '__ghostty_initialViewport'; export { native }\n",
    )
    const compile = () =>
      spawnSync('node', [join(scripts, '../node_modules/typescript/bin/tsc'), '-p', scratch], {
        encoding: 'utf8',
        timeout: 15000,
      })
    await writeFile(
      source,
      original.replace(
        "declare module 'vitest/internal/browser'",
        "declare module 'vitest/browser'",
      ),
    )
    const before = compile()
    assert.notEqual(before.status, 0)
    assert.equal((before.stdout.match(/error TS/g) ?? []).length, 20, before.stdout + before.stderr)
    await writeFile(source, original)
    await writeFile(
      join(scratch, 'coexistence.ts'),
      `
import type { BrowserCommandContext, TestProject } from 'vitest/node'
import type { BrowserCommands } from 'vitest/internal/browser'
import type { FrameworkHost } from 'waffle/testing/page-runner/framework'
type NotAny<T> = 0 extends 1 & T ? false : true
const callbackTyped: NotAny<BrowserCommands['__vitest_takeScreenshot']> = true
const registrarTyped: NotAny<NonNullable<TestProject['browser']>['registerCommand']> = true
declare const browser: NonNullable<TestProject['browser']>
declare const context: BrowserCommandContext
declare const host: FrameworkHost
browser.registerCommand('__vitest_takeScreenshot', async (_context, name, options) => {
  const typedName: string = name
  const selector: string | undefined = options.element?.selector
  void typedName; void selector
  return { buffer: Buffer.from('synthetic transport'), path: '/consumer/path.png' }
})
// @ts-expect-error Screenshot results retain their Buffer and path types.
browser.registerCommand('__vitest_takeScreenshot', async () => 42)
// @ts-expect-error The generic registrar preserves command-name/payload correlation.
browser.registerCommand('readFile', (_context, path: number) => Promise.resolve(String(path)))
// @ts-expect-error Screenshot invocation requires original options.
browser.triggerCommand('__vitest_takeScreenshot', context, 'name')
host.provider({ kind: 'viewport', width: 800.5, height: 600.5 })
// @ts-expect-error Explicit viewport has no callback.
host.provider({ kind: 'viewport', width: 800, height: 600 }, async () => {})
// @ts-expect-error Screenshot requires the exact official callback.
host.provider({ kind: 'screenshot', file: '/actual/file.ts' })
void callbackTyped; void registrarTyped
`,
    )
    const after = compile()
    assert.equal(after.status, 0, after.stdout + after.stderr)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}, 40000)

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
    assert.equal((before.stdout.match(/error TS/g) ?? []).length, 19, before.stdout + before.stderr)
    await writeFile(source, original)
    const after = compile()
    assert.equal(after.status, 0, after.stdout + after.stderr)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}, 40000)

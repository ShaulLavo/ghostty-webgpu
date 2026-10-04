import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

const packageRoot = join(import.meta.dirname, '..')
const require = createRequire(join(packageRoot, 'package.json'))
const helper = join(import.meta.dirname, 'renderer-smoke-dependency.ts')
let relocated: string

beforeEach(async () => {
  relocated = await mkdtemp(join(tmpdir(), 'ghostty-smoke-dependency-'))
  await writeFile(join(relocated, 'package.json'), JSON.stringify({ type: 'module' }))
})

afterEach(async () => {
  await rm(relocated, { recursive: true, force: true })
})

function bundleScript(): string {
  return `import { rendererSmokeHotkeys } from ${JSON.stringify(helper)};
const source = await rendererSmokeHotkeys(${JSON.stringify(relocated)});`
}

test('a relocated installed graph produces standalone ESM with working reactive key state', async () => {
  const installed = dirname(require.resolve('@fregat/hotkeys/package.json'))
  const scope = join(relocated, 'node_modules', '@fregat')
  await mkdir(scope, { recursive: true })
  await symlink(installed, join(scope, 'hotkeys'), 'junction')
  const result = spawnSync(
    'bun',
    [
      '--eval',
      `${bundleScript()}
const { KeyStateTracker } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const tracker = KeyStateTracker.getInstance();
let notifications = 0;
const subscription = tracker.store.subscribe(() => { notifications += 1; });
tracker.store.setState(state => ({ ...state, heldKeys: ['A'] }));
import assert from 'node:assert/strict';
assert.deepEqual(tracker.getHeldKeys(), ['A']);
assert.equal(notifications, 1);
subscription.unsubscribe();
KeyStateTracker.resetInstance();
console.log('standalone ESM reactive state passed');`,
    ],
    { encoding: 'utf8', timeout: 15_000 },
  )
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout.trim()).toBe('standalone ESM reactive state passed')
})

test('an uninstalled relocated root cannot silently use the harness checkout dependency', () => {
  const result = spawnSync('bun', ['--eval', bundleScript()], { encoding: 'utf8', timeout: 15_000 })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('@fregat/hotkeys')
})

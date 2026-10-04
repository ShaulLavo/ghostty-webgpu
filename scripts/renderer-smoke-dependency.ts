import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'

export async function rendererSmokeHotkeys(packageRoot: string): Promise<string> {
  const require = createRequire(join(packageRoot, 'package.json'))
  const build = await Bun.build({
    entrypoints: [require.resolve('@fregat/hotkeys')],
    target: 'browser',
    format: 'esm',
  })
  assert(build.success, build.logs.map(String).join('\n'))
  assert.equal(build.outputs.length, 1, 'The smoke dependency must be one browser module.')
  const [module] = build.outputs
  assert(module, 'The smoke dependency must contain its compiled entry.')
  return module.text()
}

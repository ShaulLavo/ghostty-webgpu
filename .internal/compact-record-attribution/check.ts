import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

function environment(name: string): string {
  const value = process.env[name]
  assert(value)
  return value
}
const root = environment('G5_REPO')
const scratch = environment('G5_SCRATCH')
const output = environment('G5_OUTPUT')
const tool = join(root, '.internal/compact-record-attribution')
await writeFile(
  join(scratch, 'tool-tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      target: 'ES2023',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      allowImportingTsExtensions: true,
      noEmit: true,
      strict: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: true,
      types: ['bun', '@webgpu/types'],
      paths: { 'ghostty-source/*': [join(root, 'src/*')] },
    },
    files: [
      'generate.ts',
      'analyze.ts',
      'probe.ts',
      'hooks.ts',
      'check.ts',
      'cleanup.ts',
      'table.ts',
      'pngjs.d.ts',
    ].map((file) => join(tool, file)),
  }),
)
async function run(command: string[], destination: string) {
  const result = Bun.spawnSync(command, { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  await writeFile(join(output, destination), Buffer.concat([result.stdout, result.stderr]))
  assert.equal(result.exitCode, 0, destination)
}
await run(
  [join(root, 'node_modules/.bin/tsc'), '--project', join(scratch, 'tool-tsconfig.json')],
  'typecheck.log',
)
await run([join(root, 'node_modules/.bin/oxlint'), tool], 'lint.log')

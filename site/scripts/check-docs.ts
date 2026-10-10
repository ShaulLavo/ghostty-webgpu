import { strict as assert } from 'node:assert'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  migrationComparison,
  migrationContext,
  migrationRendererOption,
} from '../src/examples/migration-comparison'

const root = fileURLToPath(new URL('../', import.meta.url))
const docs = join(root, 'src/content/docs')
let pages = 0
for await (const path of new Bun.Glob('**/*.{md,mdx}').scan(docs)) {
  if (/^docs\/reference\/(api|worker-api|config-api)\//.test(path)) continue
  const source = await readFile(join(docs, path), 'utf8')
  assert(
    !/^\s*```(?:ts|tsx|js|jsx|typescript|javascript)\b/m.test(source),
    `${path}: put executable samples in src/examples and display them with Code + ?raw`,
  )
  pages++
}
const snippets = join(root, '.astro/docs-snippets')
await mkdir(snippets, { recursive: true })
let fences = 0
try {
  const readme = await readFile(join(root, '../README.md'), 'utf8')
  for (const match of readme.matchAll(
    /^```(ts|tsx|js|jsx|typescript|javascript)\b[^\n]*\n([\s\S]*?)^```/gm,
  )) {
    const extension = ['tsx', 'jsx'].includes(match[1]!) ? 'tsx' : 'ts'
    await writeFile(join(snippets, `readme-${++fences}.${extension}`), match[2]! + '\nexport {}\n')
  }
  const landing = await readFile(join(root, 'src/pages/index.astro'), 'utf8')
  const samples = [
    ...landing.matchAll(/<pre class="example"[^>]*><code>([\s\S]*?)<\/code><\/pre>/g),
  ]
  assert.equal(samples.length, 2, 'Landing samples must remain covered by the type-check')
  const code = samples
    .map((sample) =>
      sample[1]!
        .replaceAll("{'{'}", '{')
        .replaceAll("{'}'}", '}')
        .replace(/<[^>]*>/g, '')
        .replaceAll('&gt;', '>')
        .replaceAll('&lt;', '<')
        .replaceAll('&amp;', '&'),
    )
    .join('\n')
  await writeFile(join(snippets, 'landing.ts'), code + '\nexport {}\n')
  const migrationSamples = migrationComparison
    .map(({ to }): string => to)
    .concat([
      `const rendererOptions = ${migrationRendererOption} satisfies GhosttyWebGpuTerminalOptions`,
    ])
  await writeFile(
    join(snippets, 'migration.ts'),
    migrationContext + migrationSamples.join('\n') + '\nexport {}\n',
  )
  const compiler = fileURLToPath(new URL('../../../node_modules/.bin/tsc', import.meta.url))
  const result = Bun.spawnSync([compiler, '--noEmit', '-p', join(root, 'tsconfig.examples.json')], {
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  assert.equal(result.exitCode, 0, 'Docs and README example type-check failed')
  console.log(
    `Docs samples checked. ${pages} authored pages; ${fences} README fences; 2 landing samples; ${migrationSamples.length} migration snippets; examples compile against built declarations.`,
  )
} finally {
  await rm(snippets, { recursive: true, force: true })
}

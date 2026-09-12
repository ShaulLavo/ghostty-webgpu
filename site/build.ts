import { access, cp, mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const siteRoot = fileURLToPath(new URL('./', import.meta.url))
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const outDir = `${siteRoot}dist/`

async function ensurePackageBuild(): Promise<void> {
  try {
    await access(`${projectRoot}dist/index.js`)
  } catch {
    throw new Error('Package dist is missing. Run `bun run build` first.')
  }
}

async function main(): Promise<void> {
  await ensurePackageBuild()
  const pkg = (await Bun.file(`${projectRoot}package.json`).json()) as { version: string }
  await rm(outDir, { force: true, recursive: true })
  await mkdir(outDir, { recursive: true })

  const result = await Bun.build({
    define: { __SITE_VERSION__: JSON.stringify(pkg.version) },
    entrypoints: [`${siteRoot}src/main.ts`],
    format: 'esm',
    minify: true,
    naming: 'main.js',
    outdir: outDir,
    sourcemap: 'linked',
    target: 'browser',
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error('Site bundle failed')
  }

  const assets = [
    [`${siteRoot}index.html`, 'index.html'],
    [`${siteRoot}styles.css`, 'styles.css'],
    [`${siteRoot}favicon.svg`, 'favicon.svg'],
    [`${projectRoot}ghostty-vt.wasm`, 'ghostty-vt.wasm'],
    [`${projectRoot}bridge.wasm`, 'bridge.wasm'],
  ] as const
  for (const [source, name] of assets) await cp(source, `${outDir}${name}`)
  console.log(`site built: ${outDir}`)
}

await main()

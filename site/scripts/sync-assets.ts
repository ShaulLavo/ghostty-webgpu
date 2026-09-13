// Copies the package wasm into public/ so the page can fetch it beside index.html.
import { access, cp, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const siteRoot = fileURLToPath(new URL('../', import.meta.url))
const projectRoot = fileURLToPath(new URL('../../', import.meta.url))

try {
  await access(`${projectRoot}dist/index.js`)
} catch {
  throw new Error('Package dist is missing. Run `bun run build` first.')
}

await mkdir(`${siteRoot}public/`, { recursive: true })
for (const name of ['ghostty-vt.wasm', 'bridge.wasm']) {
  await cp(`${projectRoot}${name}`, `${siteRoot}public/${name}`)
}

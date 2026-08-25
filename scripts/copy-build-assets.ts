import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(projectRoot, 'src/xterm/css/xterm.css')
const target = join(projectRoot, 'dist/xterm/xterm.css')

await mkdir(dirname(target), { recursive: true })
await copyFile(source, target)

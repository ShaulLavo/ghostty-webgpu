import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const scalar = args.includes('--scalar')
const outputIndex = args.indexOf('--output')
const output =
  outputIndex < 0 ? resolve(root, 'canvas-compose.wasm') : resolve(args[outputIndex + 1]!)
const zigIndex = args.indexOf('--zig')
const zig = zigIndex < 0 ? 'zig' : args[zigIndex + 1]!
await mkdir(dirname(output), { recursive: true })
const command = [
  zig,
  'build-exe',
  resolve(root, 'scripts/canvas-compose.zig'),
  '-target',
  'wasm32-freestanding',
  '-O',
  'ReleaseFast',
  '-mcpu',
  scalar ? 'baseline-simd128' : 'baseline+simd128',
  '-fno-entry',
  '-fllvm',
  '-fno-builtin',
  '-fno-stack-check',
  '-fno-stack-protector',
  '--export-memory',
  '--stack',
  '65536',
  '--initial-memory=131072',
  '--max-memory=268435456',
  '-fstrip',
].concat(
  ['alloc', 'free', 'clear', 'fill', 'stamp', 'move'].map((name) => `--export=compose_${name}`),
  [`-femit-bin=${output}`],
)
const child = Bun.spawn(command, { stdout: 'inherit', stderr: 'inherit' })
const code = await child.exited
if (code !== 0) process.exit(code)
const bytes = await readFile(output)
const module = await WebAssembly.compile(bytes)
if (WebAssembly.Module.imports(module).length !== 0)
  throw new TypeError('Compositor must be self-contained')
console.info(JSON.stringify({ output, scalar, bytes: bytes.byteLength, command }))

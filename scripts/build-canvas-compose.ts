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
  'cc',
  '--target=wasm32-freestanding',
  '-O3',
  '-nostdlib',
  '-fno-builtin',
  '-ffp-contract=off',
  '-fno-fast-math',
  scalar ? '-mno-simd128' : '-msimd128',
  ...(scalar ? [] : ['-DCOMPOSE_SIMD=1']),
  '-Wl,--no-entry',
  '-Wl,--export-memory',
  '-Wl,-z,stack-size=65536',
  '-Wl,--initial-memory=131072',
  '-Wl,--max-memory=268435456',
  '-Wl,--strip-all',
  ...['alloc', 'free', 'clear', 'fill', 'stamp', 'move'].map(
    (name) => `-Wl,--export=compose_${name}`,
  ),
  resolve(root, 'scripts/canvas-compose.c'),
  '-o',
  output,
]
const child = Bun.spawn(command, { stdout: 'inherit', stderr: 'inherit' })
const code = await child.exited
if (code !== 0) process.exit(code)
const bytes = await readFile(output)
const module = await WebAssembly.compile(bytes)
if (WebAssembly.Module.imports(module).length !== 0)
  throw new TypeError('Compositor must be self-contained')
console.info(JSON.stringify({ output, scalar, bytes: bytes.byteLength, command }))

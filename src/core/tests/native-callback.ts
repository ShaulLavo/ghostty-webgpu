import type { GhosttyRuntime } from '../runtime.js'

interface NativeCallback {
  readonly name: string
  readonly parameters: number
  readonly returnsValue: boolean
  readonly call: (...args: number[]) => number | void
}

function unsigned(value: number): number[] {
  const bytes: number[] = []
  do {
    const byte = value & 0x7f
    value >>>= 7
    bytes.push(value === 0 ? byte : byte | 0x80)
  } while (value !== 0)
  return bytes
}

function name(value: string): number[] {
  const bytes = [...new TextEncoder().encode(value)]
  return unsigned(bytes.length).concat(bytes)
}

function section(id: number, bytes: number[]): number[] {
  return [id].concat(unsigned(bytes.length), bytes)
}

// Imported functions exported by a Wasm module can enter libghostty's native function table.
export async function installNativeCallbacks(
  runtime: GhosttyRuntime,
  callbacks: readonly NativeCallback[],
): Promise<Readonly<Record<string, number>>> {
  const types = callbacks.flatMap((callback) =>
    [0x60].concat(
      unsigned(callback.parameters),
      Array<number>(callback.parameters).fill(0x7f),
      callback.returnsValue ? [1, 0x7f] : [0],
    ),
  )
  const imports = callbacks.flatMap((callback, index) =>
    name('env').concat(name(callback.name), [0], unsigned(index)),
  )
  const exports = callbacks.flatMap((callback, index) =>
    name(callback.name).concat([0], unsigned(index)),
  )
  const count = unsigned(callbacks.length)
  const module = await WebAssembly.compile(
    Uint8Array.from(
      [0, 97, 115, 109, 1, 0, 0, 0].concat(
        section(1, count.concat(types)),
        section(2, count.concat(imports)),
        section(7, count.concat(exports)),
      ),
    ),
  )
  const instance = await WebAssembly.instantiate(module, {
    env: Object.fromEntries(callbacks.map((callback) => [callback.name, callback.call])),
  })
  const table = runtime.exports.__indirect_function_table
  const start = table.grow(callbacks.length)
  return Object.fromEntries(
    callbacks.map((callback, index) => {
      table.set(start + index, instance.exports[callback.name])
      return [callback.name, start + index]
    }),
  )
}

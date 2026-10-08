import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ComposeKernel, type ComposeExports } from './kernel.js'

const root = resolve(import.meta.dirname, '../../..')
const compilerAvailable = spawnSync('zig', ['version']).status === 0
const arms: ComposeKernel[] = []
let directory = ''

beforeAll(async () => {
  if (!compilerAvailable) return
  directory = mkdtempSync(join(tmpdir(), 'canvas-compose-'))
  for (const language of ['c', 'zig']) {
    for (const scalar of [true, false]) {
      const output = join(directory, `${language}-${scalar ? 'scalar' : 'simd'}.wasm`)
      if (language === 'zig') buildZig(output, scalar)
      if (language === 'c') buildOracle(output, scalar)
      const { instance, module } = await WebAssembly.instantiate(readFileSync(output))
      expect(WebAssembly.Module.imports(module)).toEqual([])
      expect(
        WebAssembly.Module.exports(module)
          .map((entry) => `${entry.name}:${entry.kind}`)
          .sort(),
      ).toEqual(
        [
          'memory:memory',
          'compose_alloc:function',
          'compose_free:function',
          'compose_clear:function',
          'compose_fill:function',
          'compose_stamp:function',
          'compose_move:function',
        ].sort(),
      )
      arms.push(new ComposeKernel(instance.exports as unknown as ComposeExports))
    }
  }
})
afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
})

function buildZig(output: string, scalar: boolean): void {
  execFileSync('bun', [
    resolve(root, 'scripts/build-canvas-compose.ts'),
    '--output',
    output,
    ...(scalar ? ['--scalar'] : []),
  ])
}

function buildOracle(output: string, scalar: boolean): void {
  execFileSync('zig', [
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
    resolve(root, 'src/render/canvas/tests/compose-oracle.c'),
    '-o',
    output,
  ])
}

function packed(r: number, g: number, b: number, a: number): number {
  return (r | (g << 8) | (b << 16) | (a << 24)) >>> 0
}

function reference(
  destination: ArrayLike<number>,
  source: readonly number[],
  opacity = 65535,
  coverage = 255,
): number[] {
  const alpha = Math.round((source[3]! * opacity * coverage) / (65535 * 255))
  if (alpha === 0) return [destination[0]!, destination[1]!, destination[2]!, destination[3]!]
  const denominator = alpha * 255 + destination[3]! * (255 - alpha)
  const rgb = source
    .slice(0, 3)
    .map((color, channel) =>
      Math.round(
        (color * alpha * 255 + destination[channel]! * destination[3]! * (255 - alpha)) /
          denominator,
      ),
    )
  return [...rgb, Math.round(denominator / 255)]
}

function view(kernel: ComposeKernel, ptr: number, bytes: number): Uint8Array {
  return new Uint8Array(kernel.memory.buffer, ptr, bytes)
}

function fill(
  kernel: ComposeKernel,
  ptr: number,
  width: number,
  height: number,
  rgba: readonly number[],
  opacity = 65535,
): void {
  kernel.check(
    kernel.exports.compose_fill(
      ptr,
      width,
      height,
      0,
      0,
      width,
      height,
      packed(rgba[0]!, rgba[1]!, rgba[2]!, rgba[3]!),
      opacity,
    ),
  )
}

function verifyMoveBoundaries(kernel: ComposeKernel, width: number): void {
  const bytes = width * 5 * 4
  const ptr = kernel.allocate(bytes)
  const initial = Uint8Array.from({ length: bytes }, (_, index) => (index * 73 + 19) & 255)
  for (const [from, to, rows] of [
    [0, 1, 4],
    [1, 0, 4],
    [0, 0, 5],
    [0, 4, 1],
    [4, 0, 1],
    [0, 5, 0],
    [5, 0, 0],
  ]) {
    view(kernel, ptr, bytes).set(initial)
    const expected = initial.slice()
    expected.copyWithin(to! * width * 4, from! * width * 4, (from! + rows!) * width * 4)
    kernel.check(kernel.exports.compose_move(ptr, width, 5, from!, to!, rows!))
    expect(view(kernel, ptr, bytes)).toEqual(expected)
  }
  kernel.release(ptr)
}

describe.skipIf(!compilerAvailable)(
  'C and Zig scalar/SIMD composition (requires Zig compiler and bundled Clang)',
  () => {
    it('keeps ordinary unshared memory and the original initial size and growth ceiling', () => {
      for (const arm of arms) {
        expect(arm.memory.buffer).toBeInstanceOf(ArrayBuffer)
        expect(arm.memory.buffer.byteLength).toBe(131072)
        expect(() => arm.memory.grow(4096)).toThrow(RangeError)
      }
    })

    it('rejects wide source extents and preserves signed offscreen clipping before writes', () => {
      for (const arm of arms) {
        const ptr = arm.allocate(64)
        const source = arm.allocate(4)
        view(arm, ptr, 64).fill(71)
        for (const [sw, sh, stride, kind] of [
          [0xffffffff, 0xffffffff, 0xffffffff, 4],
          [1, 0xffffffff, 0xffffffff, 1],
          [0xffffffff, 1, 0xffffffff, 1],
        ])
          expect(
            arm.exports.compose_stamp(
              ptr,
              4,
              4,
              source,
              sw!,
              sh!,
              stride!,
              kind!,
              -0x80000000,
              0x7fffffff,
              0,
              0,
              4,
              4,
              0xffffffff,
              65535,
            ),
          ).toBe(0)
        for (const [x, y] of [
          [-0x80000000, 0],
          [0, -0x80000000],
          [0x7fffffff, 0x7fffffff],
        ])
          expect(
            arm.exports.compose_stamp(
              ptr,
              4,
              4,
              source,
              1,
              1,
              4,
              4,
              x!,
              y!,
              0,
              0,
              4,
              4,
              0xffffffff,
              65535,
            ),
          ).toBe(1)
        expect([...view(arm, ptr, 64)]).toEqual(Array(64).fill(71))
        arm.release(source)
        arm.release(ptr)
      }
    })

    it('preserves transparency, ordered overlap, alpha-zero bytes and faint', () => {
      for (const kernel of arms) {
        const ptr = kernel.allocate(4)
        view(kernel, ptr, 4).fill(0)
        fill(kernel, ptr, 1, 1, [255, 0, 0, 255], 32768)
        expect([...view(kernel, ptr, 4)]).toEqual([255, 0, 0, 128])
        fill(kernel, ptr, 1, 1, [0, 0, 255, 128])
        expect([...view(kernel, ptr, 4)]).toEqual(reference([255, 0, 0, 128], [0, 0, 255, 128]))
        const old = [...view(kernel, ptr, 4)]
        fill(kernel, ptr, 1, 1, [22, 90, 11, 0])
        expect([...view(kernel, ptr, 4)]).toEqual(old)
        kernel.check(kernel.exports.compose_clear(ptr, 1, 1, 0, 0, 1, 1))
        expect([...view(kernel, ptr, 4)]).toEqual([0, 0, 0, 0])
        kernel.release(ptr)
      }
    })

    it('matches an independent integer oracle for every source/destination alpha', () => {
      const pointers = arms.map((arm) => arm.allocate(4))
      for (let sa = 0; sa < 256; sa++) {
        for (let da = 0; da < 256; da++) {
          const destination = [241, 5, 127, da]
          const source = [3, 253, 118, sa]
          const expected = reference(destination, source)
          arms.forEach((arm, index) => {
            view(arm, pointers[index]!, 4).set(destination)
            fill(arm, pointers[index]!, 1, 1, source)
            expect([...view(arm, pointers[index]!, 4)]).toEqual(expected)
          })
        }
      }
      arms.forEach((arm, index) => arm.release(pointers[index]!))
    })

    it('covers effective opacity, A8 tint alpha and intrinsic RGBA without double application', () => {
      for (const kernel of arms) {
        const ptr = kernel.allocate(4)
        const source = kernel.allocate(16)
        for (const alpha of [0, 1, 64, 127, 128, 254, 255]) {
          for (const opacity of [0, 1, 257, 16384, 32768, 65534, 65535]) {
            for (const coverage of [0, 1, 63, 128, 254, 255]) {
              const destination = [73, 29, 111, alpha]
              const tint = [181, 97, 3, alpha]
              view(kernel, ptr, 4).set(destination)
              view(kernel, source, 16)[1] = coverage
              kernel.check(
                kernel.exports.compose_stamp(
                  ptr,
                  1,
                  1,
                  source + 1,
                  1,
                  1,
                  1,
                  1,
                  0,
                  0,
                  0,
                  0,
                  1,
                  1,
                  packed(...(tint as [number, number, number, number])),
                  opacity,
                ),
              )
              expect([...view(kernel, ptr, 4)]).toEqual(
                reference(destination, tint, opacity, coverage),
              )
              view(kernel, ptr, 4).set(destination)
              view(kernel, source, 16).set(tint, 1)
              kernel.check(
                kernel.exports.compose_stamp(
                  ptr,
                  1,
                  1,
                  source + 1,
                  1,
                  1,
                  4,
                  4,
                  0,
                  0,
                  0,
                  0,
                  1,
                  1,
                  0xffffffff,
                  opacity,
                ),
              )
              expect([...view(kernel, ptr, 4)]).toEqual(reference(destination, tint, opacity))
            }
          }
        }
        kernel.release(source)
        kernel.release(ptr)
      }
    })

    it('matches the C oracle for random repeated overlaps, unaligned bytes and nonvector tails', () => {
      let seed = 0x51cafe
      const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        return seed
      }
      const pointers = arms.map((arm) => arm.allocate(7 * 9 * 4 + 1))
      const expected = new Uint8Array(7 * 9 * 4)
      arms.forEach((arm, index) => view(arm, pointers[index]! + 1, expected.length).fill(0))
      for (let operation = 0; operation < 256; operation++) {
        const color = [random() & 255, random() & 255, random() & 255, random() & 255]
        const opacity = random() & 65535
        for (let p = 0; p < expected.length; p += 4)
          expected.set(reference(expected.slice(p, p + 4), color, opacity), p)
        arms.forEach((arm, index) => {
          fill(arm, pointers[index]! + 1, 7, 9, color, opacity)
          expect(view(arm, pointers[index]! + 1, expected.length)).toEqual(expected)
        })
      }
      arms.forEach((arm, index) => {
        arm.check(arm.exports.compose_clear(pointers[index]! + 1, 7, 9, 1, 2, 5, 3))
      })
      for (let index = 1; index < arms.length; index++)
        expect(view(arms[index]!, pointers[index]! + 1, expected.length)).toEqual(
          view(arms[0]!, pointers[0]! + 1, expected.length),
        )
      arms.forEach((arm, index) => arm.release(pointers[index]!))
    })

    it('clips negative origins, padded stride and restricted row rectangles', () => {
      for (const kernel of arms) {
        const ptr = kernel.allocate(5 * 3 * 4)
        const source = kernel.allocate(3 * 17)
        view(kernel, ptr, 60).fill(0)
        const bytes = view(kernel, source, 51)
        bytes.fill(99)
        for (let row = 0; row < 3; row++)
          for (let x = 0; x < 4; x++) bytes.set([row * 40, x * 50, 129, 255], row * 17 + x * 4)
        kernel.check(
          kernel.exports.compose_stamp(
            ptr,
            5,
            3,
            source,
            4,
            3,
            17,
            4,
            -1,
            -1,
            1,
            0,
            3,
            2,
            0,
            65535,
          ),
        )
        const expected = new Uint8Array(60)
        for (let row = 0; row < 2; row++)
          for (let x = 1; x < 3; x++)
            expected.set([40 * (row + 1), 50 * (x + 1), 129, 255], (row * 5 + x) * 4)
        expect(view(kernel, ptr, 60)).toEqual(expected)
        kernel.release(source)
        kernel.release(ptr)
      }
    })

    it('moves overlapping rows in both directions without a JS copy', () => {
      for (const kernel of arms) {
        const ptr = kernel.allocate(7 * 5 * 4)
        const initial = Uint8Array.from({ length: 140 }, (_, index) => index)
        for (const [from, to] of [
          [0, 1],
          [1, 0],
        ]) {
          view(kernel, ptr, 140).set(initial)
          const expected = initial.slice()
          expected.copyWithin(to! * 28, from! * 28, (from! + 4) * 28)
          kernel.check(kernel.exports.compose_move(ptr, 7, 5, from!, to!, 4))
          expect(view(kernel, ptr, 140)).toEqual(expected)
        }
        kernel.release(ptr)
      }
    })

    it('preserves vector overlap, unaligned rows, short tails, and empty moves', () => {
      for (let width = 1; width <= 17; width++)
        for (const kernel of arms) verifyMoveBoundaries(kernel, width)
    })

    it('rejects overflow, OOB, invalid stride/opacity and frame-source alias before writes', () => {
      for (const kernel of arms) {
        const ptr = kernel.allocate(64)
        view(kernel, ptr, 64).fill(71)
        expect(kernel.exports.compose_clear(ptr, 0xffffffff, 0xffffffff, 0, 0, 1, 1)).toBe(0)
        expect(kernel.exports.compose_clear(ptr, 0x80000000, 0x80000000, 0, 0, 1, 1)).toBe(0)
        expect(kernel.exports.compose_fill(ptr, 4, 4, 3, 3, 2, 1, 0, 65535)).toBe(0)
        expect(kernel.exports.compose_fill(ptr, 4, 4, 0, 0, 4, 4, 0, 65536)).toBe(0)
        expect(
          kernel.exports.compose_stamp(ptr, 4, 4, ptr, 4, 4, 16, 4, 0, 0, 0, 0, 4, 4, 0, 65535),
        ).toBe(0)
        expect(kernel.exports.compose_move(ptr, 4, 4, 0, 3, 2)).toBe(0)
        expect([...view(kernel, ptr, 64)]).toEqual(Array(64).fill(71))
        kernel.release(ptr)
        expect(kernel.exports.compose_free(ptr)).toBe(0)
      }
    })

    it('coalesces adjacent released blocks in either release order', () => {
      for (const arm of arms) {
        for (const reverse of [false, true]) {
          const first = arm.allocate(16)
          const second = arm.allocate(32)
          const guard = arm.allocate(16)
          if (reverse) {
            arm.release(second)
            arm.release(first)
          }
          if (!reverse) {
            arm.release(first)
            arm.release(second)
          }
          const joined = arm.allocate(64)
          expect(joined).toBe(first)
          arm.release(joined)
          arm.release(guard)
        }
      }
    })

    it('recycles allocations and refreshes offset views after growth', () => {
      for (const kernel of arms) {
        const ptr = kernel.allocate(32)
        const old = view(kernel, ptr, 32)
        old.fill(149)
        const large = kernel.allocate(kernel.memory.buffer.byteLength + 16)
        expect(old.byteLength).toBe(0)
        expect([...view(kernel, ptr, 32)]).toEqual(Array(32).fill(149))
        kernel.release(large)
        kernel.release(ptr)
        expect(kernel.allocate(32)).toBe(ptr)
        kernel.release(ptr)
      }
    })

    it('records packed quantization error versus retained f32 oracle without claiming a tolerance', () => {
      const kernel = arms[3]!
      const ptr = kernel.allocate(4)
      const f = Math.fround
      const reports = []
      for (const operations of [1, 8, 64, 1024]) {
        let premult = [0, 0, 0, 0]
        view(kernel, ptr, 4).fill(0)
        let maximum = 0
        for (let i = 0; i < operations; i++) {
          const source = [
            (i * 73) % 256,
            (i * 29) % 256,
            (i * 113) % 256,
            [1, 64, 127, 128, 254][i % 5]!,
          ]
          const opacity = i % 2 ? 32768 : 257
          fill(kernel, ptr, 1, 1, source, opacity)
          const alpha = f(f(source[3]! / 255) * f(opacity / 65535))
          const inverse = f(1 - alpha)
          premult = premult.map((old, channel) =>
            f(f(channel === 3 ? alpha : f(f(source[channel]! / 255) * alpha)) + f(old * inverse)),
          )
          const oracle = premult.map((value, channel) =>
            Math.min(
              255,
              Math.max(0, Math.round((channel === 3 ? value : value / premult[3]!) * 255)),
            ),
          )
          if (oracle[3] === 0) oracle.fill(0)
          maximum = Math.max(
            maximum,
            ...oracle.map((value, channel) => Math.abs(value - view(kernel, ptr, 4)[channel]!)),
          )
        }
        reports.push({
          operations,
          maxChannelDeltaAcrossSequence: maximum,
          packed: [...view(kernel, ptr, 4)],
          retainedF32: premult,
        })
      }
      console.info(JSON.stringify({ proof: 'packed versus retained f32; uncalibrated', reports }))
      kernel.release(ptr)
    })
  },
)

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { verifyCompatibilityAcrossRuntimes } from './verify-helper'

const roots: string[] = []
const node = runtimePath('node')
const bun = runtimePath('bun')
const supportedHost =
  (process.platform === 'linux' || process.platform === 'darwin') &&
  (process.arch === 'x64' || process.arch === 'arm64')
const skipReason = 'requires Node, Bun, and a native Linux or macOS x64/arm64 host'
const nativeTest = test.skipIf(!node || !bun || !supportedHost)

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

nativeTest(`runs the maintained compatibility probe in Node and Bun (${skipReason})`, () => {
  const { args, helper, binary } = compatibilityFixture()
  const result = verifyCompatibilityAcrossRuntimes(args, helper, binary)

  expect(result.minimumOsVersion).toBe(binary.minimumOsVersion)
  for (const runtime of ['node', 'bun'] as const) {
    expect(result[runtime]).toEqual({
      schemaVersion: 1,
      target: args.target,
      runtime,
      runtimeVersion: expect.stringMatching(/^\d+\.\d+\.\d+/),
      hostVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      minimumOsVersion: binary.minimumOsVersion,
      vectors: 'pass',
      result: 'pass',
    })
  }
})

nativeTest(`rejects an incompatible artifact (${skipReason})`, () => {
  const { args, helper, binary } = compatibilityFixture()
  const artifact = readFileSync(helper)
  if (process.platform === 'linux') artifact.writeUInt16LE(0, 18)
  if (process.platform === 'darwin') artifact.writeUInt32LE(0, 4)
  writeFileSync(helper, artifact)

  expect(() => verifyCompatibilityAcrossRuntimes(args, helper, binary)).toThrow(
    'compatibility runtime probe failed',
  )
})

nativeTest(`retains the binary minimum-version assertion (${skipReason})`, () => {
  const { args, helper, binary } = compatibilityFixture()

  expect(() =>
    verifyCompatibilityAcrossRuntimes(args, helper, { ...binary, minimumOsVersion: '0.0.0' }),
  ).toThrow('Node minimum compatibility mismatch')
})

function runtimePath(runtime: 'node' | 'bun'): string | null {
  const result = spawnSync(runtime, ['--print', 'process.execPath'], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  if (result.status !== 0) return null
  return result.stdout.trim()
}

function compatibilityFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ghostty-native-compatibility-'))
  roots.push(root)
  const helper = join(root, 'helper')
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const target =
    process.platform === 'darwin' ? (`darwin-${arch}` as const) : (`linux-${arch}` as const)
  const binary: Parameters<typeof verifyCompatibilityAcrossRuntimes>[2] = {
    arch,
    format: process.platform === 'darwin' ? 'mach-o-64' : 'elf64',
    linkage: process.platform === 'darwin' ? 'system-dynamic' : 'static',
    minimumOsVersion: process.platform === 'darwin' ? '13.0.0' : '5.10.0',
  }
  const artifact = Buffer.alloc(64)
  if (process.platform === 'linux') {
    artifact.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
    artifact.writeUInt16LE(arch === 'arm64' ? 183 : 62, 18)
    artifact.writeUInt16LE(56, 54)
  }
  if (process.platform === 'darwin') {
    artifact.writeUInt32LE(0xfeedfacf, 0)
    artifact.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4)
    artifact.writeUInt32LE(1, 16)
    artifact.writeUInt32LE(24, 20)
    artifact.writeUInt32LE(0x32, 32)
    artifact.writeUInt32LE(24, 36)
    artifact.writeUInt32LE(13 << 16, 44)
  }
  // The compatibility probe inspects headers; it never executes this fixture.
  writeFileSync(helper, artifact)
  return {
    helper,
    binary,
    args: {
      target,
      node: node!,
      bun: bun!,
    },
  }
}

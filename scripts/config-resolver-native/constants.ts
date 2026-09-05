export const NATIVE_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'] as const

export type NativeTarget = (typeof NATIVE_TARGETS)[number]

export const NATIVE_PACKAGE_VERSION = '0.1.2'
export const NATIVE_SCHEMA_VERSION = 1
export const NATIVE_SOURCE_DATE_EPOCH = 1_787_590_337
export const NATIVE_UPSTREAM_REPOSITORY = 'https://github.com/ghostty-org/ghostty.git'
export const NATIVE_UPSTREAM_REVISION = 'c8554f28e0efe2f5595f32020371c34b25ec628f'
export const NATIVE_UPSTREAM_TREE_SHA256 =
  '63d2b0c41531162a70b838369c0c225745e167495763ebbd0bc2fe546976a2bb'
export const NATIVE_PROOF_RECIPE_SHA256 =
  '40083f27ad5f925808cc48e0fdd428b4ab0515eb38dedb42b0ca2065a16e44f0'
export const NATIVE_ZIG_VERSION = '0.16.0'
export const NATIVE_RESOURCE_ARCHIVE_URL =
  'https://deps.files.ghostty.org/ghostty-themes-release-20260810-152212-0173c3c.tgz'
export const NATIVE_RESOURCE_ARCHIVE_BYTES = 78_218
export const NATIVE_RESOURCE_ARCHIVE_SHA256 =
  'ea9878471420ee5b12e7f2ff480099c954ea50e573a1bdf83f43e105c9be63f0'

export const NATIVE_TARGET_CEILINGS = {
  'darwin-arm64': 2_097_152,
  'darwin-x64': 2_097_152,
  'linux-arm64': 8_388_608,
  'linux-x64': 9_437_184,
} as const satisfies Readonly<Record<NativeTarget, number>>

export const NATIVE_TOTAL_CEILING = 22_020_096
export const NATIVE_MAX_ARCHIVE_OVERHEAD = 1_048_576

export const NATIVE_TARGET_CONFIG = {
  'darwin-arm64': {
    os: 'darwin',
    arch: 'arm64',
    runner: 'macos-15',
    image: 'macos15',
    imageVersion: '20260727.0256.1',
    targetTriple: 'aarch64-macos.13.0',
    zigArchiveName: 'zig-aarch64-macos-0.16.0.tar.xz',
    zigArchiveUrl: 'https://ziglang.org/download/0.16.0/zig-aarch64-macos-0.16.0.tar.xz',
    zigArchiveBytes: 52_238_004,
    zigArchiveSha256: 'b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489',
  },
  'darwin-x64': {
    os: 'darwin',
    arch: 'x64',
    runner: 'macos-15-intel',
    image: 'macos15',
    imageVersion: '20260824.0482.1',
    targetTriple: 'x86_64-macos.13.0',
    zigArchiveName: 'zig-x86_64-macos-0.16.0.tar.xz',
    zigArchiveUrl: 'https://ziglang.org/download/0.16.0/zig-x86_64-macos-0.16.0.tar.xz',
    zigArchiveBytes: 57_396_836,
    zigArchiveSha256: '0387557ed1877bc6a2e1802c8391953baddba76081876301c522f52977b52ba7',
  },
  'linux-arm64': {
    os: 'linux',
    arch: 'arm64',
    runner: 'ubuntu-24.04-arm',
    image: 'ubuntu24-arm64',
    imageVersion: '20260823.101.1',
    targetTriple: 'aarch64-linux-musl',
    zigArchiveName: 'zig-aarch64-linux-0.16.0.tar.xz',
    zigArchiveUrl: 'https://ziglang.org/download/0.16.0/zig-aarch64-linux-0.16.0.tar.xz',
    zigArchiveBytes: 51_211_944,
    zigArchiveSha256: 'ea4b09bfb22ec6f6c6ceac57ab63efb6b46e17ab08d21f69f3a48b38e1534f17',
  },
  'linux-x64': {
    os: 'linux',
    arch: 'x64',
    runner: 'ubuntu-24.04',
    image: 'ubuntu24',
    imageVersion: '20260823.283.1',
    targetTriple: 'x86_64-linux-musl',
    zigArchiveName: 'zig-x86_64-linux-0.16.0.tar.xz',
    zigArchiveUrl: 'https://ziglang.org/download/0.16.0/zig-x86_64-linux-0.16.0.tar.xz',
    zigArchiveBytes: 55_478_392,
    zigArchiveSha256: '70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00',
  },
} as const satisfies Readonly<
  Record<
    NativeTarget,
    {
      readonly os: 'darwin' | 'linux'
      readonly arch: 'arm64' | 'x64'
      readonly runner: string
      readonly image: string
      readonly imageVersion: string
      readonly targetTriple: string
      readonly zigArchiveName: string
      readonly zigArchiveUrl: string
      readonly zigArchiveBytes: number
      readonly zigArchiveSha256: string
    }
  >
>

export const NATIVE_BUILD_ROOT = {
  darwin: '/private/tmp/ghostty-config-resolver-native-build-v1',
  linux: '/tmp/ghostty-config-resolver-native-build-v1',
} as const

export const NATIVE_EXECUTABLE_PATH = 'bin/ghostty-config-resolver'
export const NATIVE_RESOURCES_ROOT = 'resources/themes'
export const NATIVE_BUILD_RECIPE_PATH = 'scripts/config-resolver-native/build-recipe.json'
export const NATIVE_INPUTS_PATH = 'scripts/config-resolver-native/native-inputs.json'
export const NATIVE_BOOTSTRAP_PATH = 'native/config-resolver/bootstrap.json'
export const NATIVE_MANIFEST_PATH = 'native/config-resolver/manifest.json'

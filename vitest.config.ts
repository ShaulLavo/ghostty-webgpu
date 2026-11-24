import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // A hang cap, not a speed limit: CPU-bound tests beside nested browser suites can pass 5s on CI.
    testTimeout: 60_000,
    // Bound per-file concurrent tests to 2 so two overlapping browser-backed unit suites cap at 4 browsers on 4-vCPU CI runners.
    maxConcurrency: 2,
    exclude: ['src/**/*.browser.test.ts', 'scripts/**/*.browser.test.ts'],
    include: [
      'src/**/*.test.ts',
      'bench/write-queue-probe.test.ts',
      'scripts/ghostty-source.test.ts',
      'scripts/ios-browser*.test.ts',
      'scripts/layout.test.ts',
      'scripts/wasm-provenance.test.ts',
      'scripts/ghostty-vt-exports.test.ts',
      'scripts/comparison-source.test.ts',
      'scripts/browser-file-roots.test.ts',
      'scripts/browser-shard.test.ts',
      'scripts/font-loading-fixture.test.ts',
      'scripts/renderer-smoke-dependency.test.ts',
      'scripts/package-tarball.test.ts',
      'scripts/release-artifacts.test.ts',
      'site/src/**/*.test.ts',
      'site-classic/src/**/*.test.ts',
      'scripts/config-resolver-native/*.test.ts',
      'demo/**/*.test.ts',
      'scripts/release-candidate/tests/**/*.test.ts',
    ],
  },
})

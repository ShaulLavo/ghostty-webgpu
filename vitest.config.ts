import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['src/**/*.browser.test.ts'],
    include: [
      'src/**/*.test.ts',
      'scripts/ghostty-source.test.ts',
      'scripts/wasm-provenance.test.ts',
      'scripts/comparison-source.test.ts',
      'scripts/browser-file-roots.test.ts',
      'scripts/renderer-smoke-dependency.test.ts',
      'scripts/package-tarball.test.ts',
      'site/src/**/*.test.ts',
      'scripts/config-resolver-native/*.test.ts',
      'demo/**/*.test.ts',
      'scripts/release-candidate/tests/**/*.test.ts',
    ],
  },
})

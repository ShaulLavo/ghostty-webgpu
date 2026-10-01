import { fileURLToPath } from 'node:url'
import { defineConfig } from 'astro/config'
import pkg from '../package.json' with { type: 'json' }

const projectRoot = fileURLToPath(new URL('../', import.meta.url))

// Deployed to GitHub Pages under the repository path.
export default defineConfig({
  base: '/ghostty-webgpu',
  // Keep the authored markup verbatim so inline whitespace renders unchanged.
  compressHTML: false,
  site: 'https://shaullavo.github.io',
  vite: {
    define: { __SITE_VERSION__: JSON.stringify(pkg.version) },
    // The browser shell needs a stub; build-time ghost rendering needs Node's real gzip.
    plugins: [
      {
        name: 'browser-shell-zlib',
        enforce: 'pre',
        resolveId(source, _importer, options) {
          if (source !== 'node:zlib' || options.ssr) return null
          return fileURLToPath(new URL('./src/zlib-stub.ts', import.meta.url))
        },
      },
    ],
    // main.ts imports the built package from ../dist, outside the site root.
    server: { fs: { allow: [projectRoot] } },
  },
})

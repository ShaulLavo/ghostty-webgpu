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
    // main.ts imports the built package from ../dist, outside the site root.
    server: { fs: { allow: [projectRoot] } },
  },
})

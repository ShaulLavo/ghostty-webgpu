import { fileURLToPath } from 'node:url'
import { defineConfig } from 'astro/config'
import type {} from '@astrojs/markdown-remark'
import pkg from '../package.json' with { type: 'json' }
import starlight from '@astrojs/starlight'
import { createStarlightTypeDocPlugin } from 'starlight-typedoc'
import starlightLinksValidator from 'starlight-links-validator'
import { docsLinks } from './scripts/docs-links.js'
import { docsTheme } from './src/docs-theme.js'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const references = [
  { entry: '../dist/index.d.ts', output: 'docs/reference/api', label: 'Main API' },
  { entry: '../dist/worker/index.d.ts', output: 'docs/reference/worker-api', label: 'Worker API' },
  {
    entry: '../dist/config-resolver/index.d.ts',
    output: 'docs/reference/config-api',
    label: 'Config resolver API',
  },
].map(({ entry, output, label }) => {
  const [plugin, sidebar] = createStarlightTypeDocPlugin()
  return {
    sidebar,
    plugin: plugin({
      entryPoints: [entry],
      tsconfig: './tsconfig.typedoc.json',
      output,
      sidebar: { label, collapsed: true },
      typeDoc: {
        name: label,
        excludePrivate: true,
        excludeInternal: true,
        excludeProtected: true,
        disableSources: true,
        entryFileName: 'index.md',
      },
    }),
  }
})

// Deployed to GitHub Pages under the repository path.
export default defineConfig({
  base: '/ghostty-webgpu',
  // Keep the authored markup verbatim so inline whitespace renders unchanged.
  compressHTML: false,
  site: 'https://shaullavo.github.io',
  integrations: [
    docsLinks(),
    starlight({
      title: 'ghostty-webgpu',
      description: 'Ghostty’s terminal core in the browser. Guides and API reference.',
      ...docsTheme,
      customCss: [...docsTheme.customCss, './src/styles/docs.css'],
      editLink: { baseUrl: 'https://github.com/ShaulLavo/fregat/edit/main/ghostty-webgpu/site/' },
      lastUpdated: true,
      social: [
        {
          icon: 'github',
          label: 'Source on GitHub',
          href: 'https://github.com/ShaulLavo/fregat/tree/main/ghostty-webgpu',
        },
      ],
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Introduction', slug: 'docs' },
            { label: 'First terminal', slug: 'docs/start/quick-start' },
            { label: 'A real shell', slug: 'docs/start/real-shell' },
            { label: 'Coming from xterm.js', slug: 'docs/start/xterm' },
            { label: 'Coming from ghostty-web', slug: 'docs/start/ghostty-web' },
          ],
        },
        { label: 'Guides', items: [{ autogenerate: { directory: 'docs/guides' } }] },
        { label: 'Examples', items: [{ autogenerate: { directory: 'docs/examples' } }] },
        {
          label: 'Reference',
          items: [
            { label: 'Options', slug: 'docs/reference/options' },
            ...references.map(({ sidebar }) => sidebar),
          ],
        },
        { label: 'Concepts', items: [{ autogenerate: { directory: 'docs/concepts' } }] },
      ],
      plugins: [
        ...references.map(({ plugin }) => plugin),
        starlightLinksValidator({
          sameSitePolicy: 'validate',
          // Starlight cannot inspect the custom landing page; verify-docs checks it in a browser.
          exclude: ['https://shaullavo.github.io/ghostty-webgpu/'],
        }),
      ],
    }),
  ],
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

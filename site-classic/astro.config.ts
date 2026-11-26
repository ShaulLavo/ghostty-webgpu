import { fileURLToPath } from 'node:url'
import { defineConfig } from 'astro/config'
import type {} from '@astrojs/markdown-remark'
import pkg from '../package.json' with { type: 'json' }
import starlight from '@astrojs/starlight'
import { createStarlightTypeDocPlugin } from 'starlight-typedoc'
import starlightLinksValidator from 'starlight-links-validator'
import { docsLinks } from '../site/scripts/docs-links.js'
import { docsTheme } from './src/docs-theme.js'
import { packageAliases } from '../site/scripts/package-aliases.js'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const sharedDocs = fileURLToPath(new URL('../site/src/content/docs/', import.meta.url))
const classicDocs = fileURLToPath(new URL('./src/content/docs/', import.meta.url))
const referenceItems: NonNullable<Parameters<typeof starlight>[0]['sidebar']> = [
  { label: 'Options', slug: 'docs/reference/options' },
]
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

export default defineConfig({
  base: '/ghostty-webgpu/',
  // Keep the authored markup verbatim so inline whitespace renders unchanged.
  compressHTML: false,
  site: process.env.SITE_ORIGIN ?? 'https://shaullavo.github.io',
  integrations: [
    docsLinks(),
    starlight({
      title: 'ghostty-webgpu',
      description: 'Ghostty’s terminal core in the browser. Guides and API reference.',
      ...docsTheme,
      components: { Head: './src/components/DocsHead.astro' },
      customCss: docsTheme.customCss.concat(['./src/styles/docs.css']),
      editLink: {
        baseUrl: 'https://github.com/ShaulLavo/ghostty-webgpu/edit/main/site/',
      },
      lastUpdated: true,
      social: [
        {
          icon: 'github',
          label: 'Source on GitHub',
          href: 'https://github.com/ShaulLavo/ghostty-webgpu',
        },
      ],
      sidebar: [
        {
          label: 'Learn',
          items: [
            { label: 'Overview', slug: 'docs' },
            { label: 'Quick start', slug: 'docs/start/quick-start' },
            { label: 'Connect a real shell', slug: 'docs/start/real-shell' },
            { label: 'Interactive echo demo', slug: 'docs/examples/echo' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Wire a PTY', slug: 'docs/guides/pty' },
            { label: 'Renderers & fallbacks', slug: 'docs/guides/renderers' },
            { label: 'Run in a worker', slug: 'docs/guides/workers' },
            { label: 'Fonts & grid sizing', slug: 'docs/guides/fonts' },
            { label: 'Themes & Ghostty config', slug: 'docs/guides/themes' },
            { label: 'Keyboard & hotkeys', slug: 'docs/guides/hotkeys' },
            { label: 'Scrollback & history', slug: 'docs/guides/scrollback' },
          ],
        },
        {
          label: 'Migration',
          items: [
            { label: 'From xterm.js', slug: 'docs/start/xterm' },
            { label: 'From ghostty-web', slug: 'docs/start/ghostty-web' },
          ],
        },
        {
          label: 'Architecture',
          items: [
            { label: 'How the WASM core works', slug: 'docs/concepts/how-it-works' },
            { label: 'Per-cell damage tracking', slug: 'docs/concepts/damage-tracking' },
            { label: 'Benchmarks', slug: 'docs/concepts/benchmarks' },
          ],
        },
        {
          label: 'Reference',
          items: referenceItems.concat(references.map(({ sidebar }) => sidebar)),
        },
      ],
      plugins: references
        .map(({ plugin }) => plugin)
        .concat([
          starlightLinksValidator({
            sameSitePolicy: 'validate',
            // Starlight cannot inspect the custom landing page; verify-docs checks it in a browser.
            exclude: ['https://shaullavo.github.io/ghostty-webgpu/'],
          }),
        ]),
    }),
  ],
  vite: {
    resolve: { alias: packageAliases },
    define: { __SITE_VERSION__: JSON.stringify(pkg.version) },
    // The browser shell needs a stub; build-time ghost rendering needs Node's real gzip.
    plugins: [
      {
        name: 'classic-docs-paths',
        enforce: 'pre',
        resolveId(source) {
          // The link validator derives page identities from the site-local Markdown path.
          if (source.startsWith(classicDocs)) return source
          if (source.startsWith(sharedDocs)) return classicDocs + source.slice(sharedDocs.length)
          return null
        },
      },
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
    preview: { strictPort: true },
  },
})

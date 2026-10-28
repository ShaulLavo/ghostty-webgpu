import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const result = await Bun.build({
  entrypoints: ['row.ts', 'selection.ts'].map((entry) => resolve(root, 'src/bidi', entry)),
  outdir: resolve(root, 'dist/bidi'),
  target: 'browser',
  format: 'esm',
  splitting: true,
  sourcemap: 'external',
  plugins: [
    {
      name: 'shared-native-modules',
      setup(build) {
        build.onResolve({ filter: /^\.\.\/(?:core|render|term)\// }, (args) => ({
          path: args.path,
          external: true,
        }))
      },
    },
  ],
})
if (!result.success) throw new AggregateError(result.logs, 'Unable to build optional BiDi modules')

import { fileURLToPath } from 'node:url'

// The mirror's package root is outside its site workspaces, so resolve the built entry points directly.
export const packageAliases = [
  {
    find: /^ghostty-webgpu$/,
    replacement: fileURLToPath(new URL('../../dist/index.js', import.meta.url)),
  },
  {
    find: /^ghostty-webgpu\/hotkeys$/,
    replacement: fileURLToPath(new URL('../../dist/extensions/hotkeys/index.js', import.meta.url)),
  },
  {
    find: /^ghostty-webgpu-line-editor$/,
    replacement: fileURLToPath(
      new URL('../../packages/line-editor/dist/index.js', import.meta.url),
    ),
  },
  {
    find: /^ghostty-webgpu\/worker$/,
    replacement: fileURLToPath(new URL('../../dist/worker/index.js', import.meta.url)),
  },
]

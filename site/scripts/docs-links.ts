import { unified } from '@astrojs/markdown-remark'
import type { AstroIntegration } from 'astro'

const publishedDocs = 'https://shaullavo.github.io/ghostty-webgpu/docs/'

interface MarkdownNode {
  type: string
  url?: string
  children?: MarkdownNode[]
}

function rewriteLinks(node: MarkdownNode, base: string): void {
  if (node.url?.startsWith(publishedDocs)) {
    node.url = `${base}/docs/${node.url.slice(publishedDocs.length)}`
  }
  for (const child of node.children ?? []) rewriteLinks(child, base)
}

export function docsLinks(): AstroIntegration {
  return {
    name: 'ghostty-docs-links',
    hooks: {
      'astro:config:setup': ({ config, updateConfig }) => {
        const base = config.base.replace(/\/$/, '')
        updateConfig({
          markdown: {
            processor: unified({
              remarkPlugins: [() => (tree: MarkdownNode) => rewriteLinks(tree, base)],
            }),
          },
        })
      },
    },
  }
}

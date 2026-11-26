import { unified } from '@astrojs/markdown-remark'
import type { AstroIntegration } from 'astro'

const publishedDocs = 'https://ghostty.shaulavo.dev/docs/'

interface MarkdownNode {
  type: string
  url?: string
  children?: MarkdownNode[]
}

interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

function rewriteLinks(node: MarkdownNode, base: string): void {
  if (node.url?.startsWith(publishedDocs)) {
    node.url = `${base}/docs/${node.url.slice(publishedDocs.length)}`
  }
  for (const child of node.children ?? []) rewriteLinks(child, base)
}

function textContent(node: HastNode): string {
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(textContent).join('')
}

function labelTable(table: HastNode): void {
  const thead = table.children?.find((child) => child.tagName === 'thead')
  const headerRow = thead?.children?.find((child) => child.tagName === 'tr')
  if (!headerRow) return
  const headers = (headerRow.children ?? [])
    .filter((child) => child.tagName === 'th')
    .map((cell) => textContent(cell).trim())
  if (headers.length === 0) return

  const tbody = table.children?.find((child) => child.tagName === 'tbody')
  for (const row of tbody?.children ?? []) {
    if (row.tagName !== 'tr') continue
    let column = 0
    for (const cell of row.children ?? []) {
      if (cell.tagName !== 'td') continue
      const label = headers[column]
      column += 1
      if (!label) continue
      cell.properties ??= {}
      if (cell.properties['data-label'] === undefined) {
        cell.properties['data-label'] = label
      }
    }
  }
}

function labelTableCells(node: HastNode): void {
  if (node.tagName === 'table') labelTable(node)
  for (const child of node.children ?? []) labelTableCells(child)
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
              rehypePlugins: [() => (tree: HastNode) => labelTableCells(tree)],
            }),
          },
        })
      },
    },
  }
}

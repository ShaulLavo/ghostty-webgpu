import assert from 'node:assert/strict'
import { parseSync } from 'oxc-parser'

interface AllocationSite {
  readonly id: string
  readonly start: number
  readonly end: number
  readonly kind: string
  readonly line: number
  readonly text: string
}

const kinds = new Set([
  'ArrayExpression',
  'ObjectExpression',
  'NewExpression',
  'ArrowFunctionExpression',
])

export function instrumentAllocations(source: string) {
  const parsed = parseSync('manager.ts', source)
  assert.equal(parsed.errors.length, 0)
  const sites: AllocationSite[] = []
  collectSites(parsed.program, source, sites)
  const markers = sites.flatMap((site) => [
    {
      at: site.start,
      text: `__owned(${JSON.stringify(site.id)}, (`,
      open: true,
      length: site.end - site.start,
    },
    { at: site.end, text: '))', open: false, length: site.end - site.start },
  ])
  markers.sort((a, b) => b.at - a.at || Number(a.open) - Number(b.open) || a.length - b.length)
  let transformed = source
  for (const marker of markers)
    transformed = transformed.slice(0, marker.at) + marker.text + transformed.slice(marker.at)
  const prefix = `function __owned<T>(site: string, value: T): T {
    const counters = (globalThis as typeof globalThis & { __extensionOwned?: Record<string, number> }).__extensionOwned
    if (counters) counters[site] = (counters[site] ?? 0) + 1
    return value
  }\n`
  return { source: prefix + transformed, sites }
}

function collectSites(value: unknown, source: string, sites: AllocationSite[]): void {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectSites(item, source, sites)
    return
  }
  const node = value as Record<string, unknown>
  const type = String(node.type)
  const start = Number(node.start)
  const end = Number(node.end)
  const text = source.slice(start, end)
  let kind = kinds.has(type) ? type : undefined
  if (type === 'FunctionExpression' && /^(?:async\s+)?function\b/.test(text)) kind = type
  if (type === 'CallExpression' && text.startsWith('Object.entries(')) kind = 'EntriesFactory'
  if (kind)
    sites.push({
      id: `${kind}@${start}`,
      start,
      end,
      kind,
      line: source.slice(0, start).split('\n').length,
      text,
    })
  for (const [key, child] of Object.entries(node)) {
    if (key === 'parent') continue
    collectSites(child, source, sites)
  }
}

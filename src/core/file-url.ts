interface NodeFileModule {
  readFile(path: URL): Promise<Uint8Array>
}

interface NodeProcess {
  getBuiltinModule?(name: string): unknown
}

export async function readNodeFileUrl(url: URL): Promise<ArrayBuffer> {
  const module = await nodeFileModule()
  const bytes = await module.readFile(url)
  return Uint8Array.from(bytes).buffer
}

async function nodeFileModule(): Promise<NodeFileModule> {
  const runtime = (globalThis as { readonly process?: NodeProcess }).process
  const loaded = runtime?.getBuiltinModule?.('fs/promises')
  if (isNodeFileModule(loaded)) return loaded

  // Keep the legacy Node fallback opaque to browser dependency scanners.
  const specifier = ['node', 'fs/promises'].join(':')
  const imported: unknown = await import(specifier)
  if (isNodeFileModule(imported)) return imported
  throw new TypeError('Node file module is unavailable')
}

function isNodeFileModule(value: unknown): value is NodeFileModule {
  if (!value || typeof value !== 'object') return false
  return typeof (value as { readonly readFile?: unknown }).readFile === 'function'
}

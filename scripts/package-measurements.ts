import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { brotliCompressSync, gzipSync } from 'node:zlib'

export function transferBytes(bytes: Uint8Array): { raw: number; gzip: number; brotli: number } {
  return {
    raw: bytes.byteLength,
    gzip: gzipSync(bytes).byteLength,
    brotli: brotliCompressSync(bytes).byteLength,
  }
}

export async function installedBytes(root: string): Promise<number> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true })
  let bytes = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    bytes += (await stat(join(entry.parentPath, entry.name))).size
  }
  return bytes
}

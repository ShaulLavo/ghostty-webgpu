import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { NativeStage } from './ios-browser-options.ts'
import { nativeStage } from './ios-browser-stages.ts'

// These source identities bind the independent manifests to the complete original files.
export const nativeSourceHashes = {
  synthetic: '03a1e75067aa2b740cb42610398515b727410bd7f84cb3b5bb0d1f97c93cd9a3',
  viewport: 'fd9b16ee545bce85c021f522e79d4d5d58b71e86f57d4da87c006857e162f2da',
  'bulk-snapshot': '172d11118d4f39b977dd801d8c50c2b54449f803a0620e018bdfd1e8d8aaa7e2',
  'font-resources': 'd9a65ca1f6e94fb613d02d14b00a8a4d98cf5107775ed308d8579f8e7427c227',
} satisfies Record<NativeStage, string>

export async function verifyNativeSource(stage: NativeStage): Promise<void> {
  const selected = nativeStage(stage)
  const bytes = await readFile(selected.file)
  if (createHash('sha256').update(bytes).digest('hex') !== nativeSourceHashes[stage])
    throw new Error(`Native manifest source changed: ${selected.file}`)
}

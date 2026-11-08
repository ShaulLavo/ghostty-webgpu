import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { NativeStage } from './ios-browser-options.ts'
import { nativeStage } from './ios-browser-stages.ts'

// These source identities bind the independent manifests to the complete original files.
export const nativeSourceHashes = {
  'ui-declarations': '3580bc912afaeb0a82a3c55b4d8daec7b8346e6a48da880316b1d5a1a45214ad',
  'output-timing': 'fb4cca0c5fc5f101fab205bf098ad5d5681ad454d43d0847743534da10767e09',
  'mac-keybindings': '9e78a60a51c3414918ded78585b401baa7c5bc7899558cee3470c09b3bbf25aa',
  'ghostty-keymap': '7ef02f9e9e292b4274d67967d31d254afff35acb9aa13f38ed812d167e68b780',
  'dom-appearance': 'e8a24dfb18a1ffb105254f7bb17557a5d528286567f1706f855c30bbe90b2286',
  'mounted-scroll': 'e044ff0a8282132982d31ec3fa5c6da8ceccd254b9b002772935ba8ffc391e51',
  'pixel-damage': '8b16f1b80a08a310226b8f9123e3fb5d94ea4a3ccb9575905c13ea51a08dc9f2',
  'stamp-cache': '2cf8b38f0e3e96b61c49bb97e38228ae1354555362ba751e1808758b7fc3734f',
  'canvas-rasterizer': '8572318c4f8d21597e3f2bcc6839b9e4e995fdc232c861b9c7eec673712fea8a',
  'font-geometry': 'dcff759bd96b31d31502d8e4def1779cf8d2b3d205fc707bec22b2da2f867f5a',
  'font-fixture': '486c29aff0129d653623f7c2e648a3af9dff54633d5839c9cf2b8b9dc2a92086',
  'module-mock': '1c86b14a70f1e4fd5ddd9b34fb1d15e568658f7c6ad5d0af79acef4c510d1d0c',
  history: 'f9d670f62eedce72fd0ef59e7c8399491224af3982c497d25a0641630bd8bc05',
  'readline-layout': 'f77d6fb706f1ab763419bfbc9b79b24f6b95d04728da935ff03c80564bee5eaa',
  'write-queue': '3d2e8fed2f337cdce6a002f5a2c255ae2186c3895dbeb036a8645593fa2be851',
  presentation: '260ba662d05c79c94cf882b41d2fec08bed3729071d8b4a824333623a2f2e004',
  'scrollbar-async': '91523a381d83ef2e6edc4c9e3f7c81413a16245bcdf1923de4e61eeb4862b778',
  synthetic: '03a1e75067aa2b740cb42610398515b727410bd7f84cb3b5bb0d1f97c93cd9a3',
  viewport: 'fd9b16ee545bce85c021f522e79d4d5d58b71e86f57d4da87c006857e162f2da',
  'bulk-snapshot': '172d11118d4f39b977dd801d8c50c2b54449f803a0620e018bdfd1e8d8aaa7e2',
  measurement: '314c6aa438c4360fdcd1d82a703af17554d431bf7c9a826c4c36785dba68b6e3',
  'font-resources': 'd9a65ca1f6e94fb613d02d14b00a8a4d98cf5107775ed308d8579f8e7427c227',
} satisfies Record<NativeStage, string>

export async function verifyNativeSource(stage: NativeStage): Promise<void> {
  const selected = nativeStage(stage)
  const bytes = await readFile(selected.file)
  if (createHash('sha256').update(bytes).digest('hex') !== nativeSourceHashes[stage])
    throw new Error(`Native manifest source changed: ${selected.file}`)
}

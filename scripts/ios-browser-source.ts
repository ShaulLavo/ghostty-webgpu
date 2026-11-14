import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { NativeStage } from './ios-browser-options.ts'
import { nativeStage } from './ios-browser-stages.ts'

// These source identities bind the independent manifests to the complete original files.
export const nativeSourceHashes = {
  'legacy-text': '3335534124bd8eb476e9e66c6e93028d31a33532354c009c5a54dbec10cdcf70',
  'pointer-selection': 'd1504dac38906a9dbe6d0326ed390350ed94aa4201a381ec20a5c8f464b65b6e',
  'hotkeys-focus': 'a589db2abdb54e8553ccf9afba7e7601faef7e0bd8149599afcf10f790141674',
  'renderer-benchmark': '75a26d4536fd34a33dea03432f096e763b4c0029534df16f1518fdb944fd83f6',
  'text-pass': 'f54d444352c28e0ce3bc536ebf18fae6ea2efa9a4d2720674f1b8233f5589b83',
  selector: '29d2d7bf7b03d50e412e7d684c200e42e59bc102f4ef6d0b742a41aa1e793f71',
  'shared-atlas': 'e07542f65b3a1c9d69ed2702e6ab5565bd3680c0dbf238b16aff289648380df8',
  webgpu: 'cf5a892d5408e08a3eb2cf9e173eb4eef6bdd16033878136c7f027200983537d',
  'atlas-registry': 'a83e3be81d52bb63d1174963720a6aec96e4adcd937f3d80c7889372d7685e67',
  'gpu-textures': '36d97f545cd9c4df0da5173519905fa0202940e3b39bd220f71fa0c60bb2db40',
  'displayed-frame-boundaries': 'df5f3a6ac14222cb76cc7322af05f0a74f2fecba306597d2ce75b5cd844976dc',
  'canvas-image': 'ead9ed76c4b5579202883e57c9f4d0eddf4596703d87fe3ca1411afb8e8c0ab5',
  'selection-worker-ownership': '04967ecf3e1216ab7fbd01ac22ffc501f4d3cb19a7877c8f67c2d5e0733529ff',
  'glyph-fidelity': '3ce593ef9b04763ab23567d82fd8f45affdacc7aee086d3ee87a7a7e25cf4226',
  'worker-write-queue': '88ffb67c4b60da4185d9cca4e67a97779ec7cdcd135f3ad9475b7b7f55c53fc9',
  'managed-fallback': '9e60c1ddcaa14dd6d0cab493021e94ea76ecde8b130053fc263f65600bf68fea',
  'ui-declarations': '584ceefab74d950490fb69b6573b8bd095dfa4486badf3b34f4d4c0a7de9dec4',
  'output-timing': 'bf0c2d070b92cb9f069c23b0ae1f806ed3e8a3034a86ee292109ce29146b2e15',
  'mac-keybindings': '39e5e56d97a3ef3ca7e153dea5e07b02208ccb42c82f891717dc5b891a575464',
  'ghostty-keymap': '7ef02f9e9e292b4274d67967d31d254afff35acb9aa13f38ed812d167e68b780',
  'dom-appearance': 'e8a24dfb18a1ffb105254f7bb17557a5d528286567f1706f855c30bbe90b2286',
  'mounted-scroll': 'e044ff0a8282132982d31ec3fa5c6da8ceccd254b9b002772935ba8ffc391e51',
  'canvas-theme-cache': '6b84137d0b0c083257806bf61c94b0aae0de816e3877f1313615e8822b711163',
  'canvas-zwj': '3d79a6f37c2c82dd2ecdab524110db44a8e12cb0adef9bc199546834681b3393',
  pixels: '19e262a6c888acaa94b27f63e2c0d254a31265e062d788383520a9d591099f1e',
  'glyph-constraints': '9f05fa19c21785d96096d21c34541c97e8b9807159858a376c51f3eebeb1f592',
  sprites: '8c2315f259f95962b455ac05d0eb9ad627fca5d0ee2b8190a8dd02900ca554d3',
  'displayed-pixels-fixture': 'bf1a8296342bb21c73db9bb6b360ac212e91592cb9f1667425e6fbc28c924a68',
  'canvas-scroll': 'c0f27b373480665c78c16b0cde21af6f5e7b442f5099b8e910df99b51c0b02f9',
  'pixel-damage': '8b16f1b80a08a310226b8f9123e3fb5d94ea4a3ccb9575905c13ea51a08dc9f2',
  'stamp-cache': '2cf8b38f0e3e96b61c49bb97e38228ae1354555362ba751e1808758b7fc3734f',
  'canvas-rasterizer': '8572318c4f8d21597e3f2bcc6839b9e4e995fdc232c861b9c7eec673712fea8a',
  'font-geometry': 'dcff759bd96b31d31502d8e4def1779cf8d2b3d205fc707bec22b2da2f867f5a',
  'font-fixture': '486c29aff0129d653623f7c2e648a3af9dff54633d5839c9cf2b8b9dc2a92086',
  'module-mock': '1c86b14a70f1e4fd5ddd9b34fb1d15e568658f7c6ad5d0af79acef4c510d1d0c',
  history: '79041b297947dd29b15db47c309c67824920e4fa4f6e4d188d0a190237b5073e',
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

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { NativeStage } from './ios-browser-options.ts'
import { nativeStage } from './ios-browser-stages.ts'

// These source identities bind the independent manifests to the complete original files.
export const nativeSourceHashes = {
  'legacy-text': '3335534124bd8eb476e9e66c6e93028d31a33532354c009c5a54dbec10cdcf70',
  'pointer-selection': 'd1504dac38906a9dbe6d0326ed390350ed94aa4201a381ec20a5c8f464b65b6e',
  'hotkeys-focus': 'a589db2abdb54e8553ccf9afba7e7601faef7e0bd8149599afcf10f790141674',
  'renderer-benchmark': 'e025ea0f0024a4830580947175b7a2b72adc503a886f1ac0646d6cdcd35aa5cc',
  'text-pass': '5c58ec4ccd9c44126ec14914deb6371dca412d6c8b19832bf36a8989d0fb5e6e',
  selector: 'cac326816f5b68c39af13b661cf45ce56369bd8c1f9aa3fa427e444cd17ffe49',
  'shared-atlas': '42b25016dc2aa80f6c94673b2b9433ec1cda2a60d760286e733850edc5d60462',
  webgpu: '2a809f046fa87abd860bc2f5f3a440ebeb3ba64c6ea9b5cf464c7ed99893808c',
  'atlas-registry': 'a83e3be81d52bb63d1174963720a6aec96e4adcd937f3d80c7889372d7685e67',
  'gpu-textures': '90c07526dac34b6919c718c9515f637119312c491e2cbf2c6a748834f892ad6f',
  'displayed-frame-boundaries': 'f84ada3a66c7a6782e325d19dac7b153cac786541a1eea3e41c995bb6d355036',
  'canvas-image': '27af5fb0c6a5b0c2cc675c90eb0f1c76e208ae0737cbc316a68e1d91b65c7d22',
  'selection-worker-ownership': '42138cdee90cb593014e0cf6b65658feb47839d2c97148b93a029c8889cc8352',
  'glyph-fidelity': '3ce593ef9b04763ab23567d82fd8f45affdacc7aee086d3ee87a7a7e25cf4226',
  'worker-write-queue': '2d3dfc47518cce2471378216660e62404f3a4c37880b71b379b4950e002ca4d8',
  'managed-fallback': '9e60c1ddcaa14dd6d0cab493021e94ea76ecde8b130053fc263f65600bf68fea',
  'ui-declarations': '3580bc912afaeb0a82a3c55b4d8daec7b8346e6a48da880316b1d5a1a45214ad',
  'output-timing': 'fb4cca0c5fc5f101fab205bf098ad5d5681ad454d43d0847743534da10767e09',
  'mac-keybindings': '9e78a60a51c3414918ded78585b401baa7c5bc7899558cee3470c09b3bbf25aa',
  'ghostty-keymap': '7ef02f9e9e292b4274d67967d31d254afff35acb9aa13f38ed812d167e68b780',
  'dom-appearance': 'e8a24dfb18a1ffb105254f7bb17557a5d528286567f1706f855c30bbe90b2286',
  'mounted-scroll': 'e044ff0a8282132982d31ec3fa5c6da8ceccd254b9b002772935ba8ffc391e51',
  'canvas-theme-cache': '6b84137d0b0c083257806bf61c94b0aae0de816e3877f1313615e8822b711163',
  'canvas-zwj': '3d79a6f37c2c82dd2ecdab524110db44a8e12cb0adef9bc199546834681b3393',
  pixels: '19e262a6c888acaa94b27f63e2c0d254a31265e062d788383520a9d591099f1e',
  'glyph-constraints': '9f05fa19c21785d96096d21c34541c97e8b9807159858a376c51f3eebeb1f592',
  sprites: '6e792785d462a8059d486900b3804ab48699631ead04764686aa98d754fda02f',
  'displayed-pixels-fixture': 'bf1a8296342bb21c73db9bb6b360ac212e91592cb9f1667425e6fbc28c924a68',
  'canvas-scroll': '7e84e87bfea3408774a4caaa517dda7e80e1dd53dec5954803ff55e01e2769c0',
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

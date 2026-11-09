import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const pointerSelectionFile = fileURLToPath(
  new URL('../src/dom/tests/pointer-selection.browser.test.ts', import.meta.url),
)

export const pointerSelectionCases = [
  {
    file: pointerSelectionFile,
    fullName:
      'physical pointer projections > keeps raw mouse pixels while subtracting asymmetric padding only for selection viewport',
    sourceKey: 'src/dom/tests/pointer-selection.browser.test.ts:296:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pointerSelectionFile,
    fullName:
      'native mouse routing > refuses pointer ownership without cancelling browser defaults and releases active state',
    sourceKey: 'src/dom/tests/pointer-selection.browser.test.ts:328:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pointerSelectionFile,
    fullName:
      'native mouse routing > encodes SGR cell and pixel coordinates and pairs captured outside release',
    sourceKey: 'src/dom/tests/pointer-selection.browser.test.ts:380:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pointerSelectionFile,
    fullName:
      'native mouse routing > preserves native same-cell dedupe and accepts the same position after a VT write',
    sourceKey: 'src/dom/tests/pointer-selection.browser.test.ts:420:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pointerSelectionFile,
    fullName:
      'native mouse routing > switches tracked drags exclusively to Shift selection and cleans lost capture state',
    sourceKey: 'src/dom/tests/pointer-selection.browser.test.ts:443:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pointerSelectionFile,
    fullName:
      'native mouse routing > contains synchronous session failures and reports an operation-tagged error',
    sourceKey: 'src/dom/tests/pointer-selection.browser.test.ts:493:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pointerSelectionFile,
    fullName: 'wheel routing > sends cursor arrows for alternate-screen scrolling with DECSET 1007',
    sourceKey: 'src/dom/tests/pointer-selection.browser.test.ts:530:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pointerSelectionFile,
    fullName:
      'wheel routing > defaults alternate scroll on and follows live alternate-scroll and cursor-key modes',
    sourceKey: 'src/dom/tests/pointer-selection.browser.test.ts:541:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pointerSelectionFile,
    fullName:
      'wheel routing > gives mouse tracking priority and does not turn Shift override into arrows',
    sourceKey: 'src/dom/tests/pointer-selection.browser.test.ts:564:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pointerSelectionFile,
    fullName:
      'wheel routing > accumulates alternate-scroll pixels, clears selection, and ignores horizontal wheel',
    sourceKey: 'src/dom/tests/pointer-selection.browser.test.ts:580:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pointerSelectionFile,
    fullName:
      'wheel routing > accumulates pixel residuals for viewport scrolling and emits native wheel pairs when tracked',
    sourceKey: 'src/dom/tests/pointer-selection.browser.test.ts:598:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pointerSelectionFile,
    fullName:
      'native selection routing > uses native word and line click repetition at the first padded row',
    sourceKey: 'src/dom/tests/pointer-selection.browser.test.ts:638:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pointerSelectionFile,
    fullName:
      'native selection routing > installs native rectangular selections without a DOM range model',
    sourceKey: 'src/dom/tests/pointer-selection.browser.test.ts:671:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pointerSelectionFile,
    fullName:
      'native selection routing > autoscrolls through history on the injected clock and exhaustively cancels timers',
    sourceKey: 'src/dom/tests/pointer-selection.browser.test.ts:698:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]

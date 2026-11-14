import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const uiDeclarationsFile = fileURLToPath(
  new URL('../src/dom/tests/ui-declarations.browser.test.ts', import.meta.url),
)

export const uiDeclarationsCases = [
  {
    file: uiDeclarationsFile,
    fullName:
      'terminal UI declarations > styles the first visible preedit synchronously and leaves idle appearance untouched',
    sourceKey: 'src/dom/tests/ui-declarations.browser.test.ts:124:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: uiDeclarationsFile,
    fullName:
      'terminal UI declarations > styles the first worker preedit with actor metrics (host font loaded: false)',
    sourceKey: 'src/dom/tests/ui-declarations.browser.test.ts:157:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: uiDeclarationsFile,
    fullName:
      'terminal UI declarations > styles the first worker preedit with actor metrics (host font loaded: true)',
    sourceKey: 'src/dom/tests/ui-declarations.browser.test.ts:157:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: uiDeclarationsFile,
    fullName:
      'terminal UI declarations > restores active preedit after a renderer peer in the same callback',
    sourceKey: 'src/dom/tests/ui-declarations.browser.test.ts:211:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: uiDeclarationsFile,
    fullName:
      'terminal UI declarations > restores priority-only changes to owned preedit and caret declarations',
    sourceKey: 'src/dom/tests/ui-declarations.browser.test.ts:226:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: uiDeclarationsFile,
    fullName:
      'terminal UI declarations > supports active preedit in a supplied inert-document element',
    sourceKey: 'src/dom/tests/ui-declarations.browser.test.ts:250:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: uiDeclarationsFile,
    fullName:
      'terminal UI declarations > releases preedit cache and observer ownership when the optional element disappears',
    sourceKey: 'src/dom/tests/ui-declarations.browser.test.ts:259:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: uiDeclarationsFile,
    fullName:
      'terminal UI declarations > restores caret declarations after exposed inline styles change',
    sourceKey: 'src/dom/tests/ui-declarations.browser.test.ts:267:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: uiDeclarationsFile,
    fullName:
      'terminal UI declarations > restores preedit appearance after exposed inline styles change',
    sourceKey: 'src/dom/tests/ui-declarations.browser.test.ts:278:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: uiDeclarationsFile,
    fullName:
      'terminal UI declarations > restores preedit appearance after a peer callback in the same native frame',
    sourceKey: 'src/dom/tests/ui-declarations.browser.test.ts:286:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: uiDeclarationsFile,
    fullName:
      'terminal UI declarations > applies appearance to a replacement supplied composition element',
    sourceKey: 'src/dom/tests/ui-declarations.browser.test.ts:293:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: uiDeclarationsFile,
    fullName:
      'terminal UI declarations > retains preedit appearance during row edits with unchanged font and theme',
    sourceKey: 'src/dom/tests/ui-declarations.browser.test.ts:301:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: uiDeclarationsFile,
    fullName:
      'terminal UI declarations > keeps owned caret declarations until validated coordinates change',
    sourceKey: 'src/dom/tests/ui-declarations.browser.test.ts:338:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]

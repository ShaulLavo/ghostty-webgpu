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
    sourceKey: 'src/dom/tests/ui-declarations.browser.test.ts:123:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: uiDeclarationsFile,
    fullName:
      'terminal UI declarations > styles the first worker preedit with actor metrics (host font loaded: false)',
    sourceKey: 'src/dom/tests/ui-declarations.browser.test.ts:156:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: uiDeclarationsFile,
    fullName:
      'terminal UI declarations > styles the first worker preedit with actor metrics (host font loaded: true)',
    sourceKey: 'src/dom/tests/ui-declarations.browser.test.ts:156:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: uiDeclarationsFile,
    fullName:
      'terminal UI declarations > restores active preedit after a renderer peer in the same callback',
    sourceKey: 'src/dom/tests/ui-declarations.browser.test.ts:209:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: uiDeclarationsFile,
    fullName:
      'terminal UI declarations > restores priority-only changes to owned preedit and caret declarations',
    sourceKey: 'src/dom/tests/ui-declarations.browser.test.ts:224:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: uiDeclarationsFile,
    fullName:
      'terminal UI declarations > supports active preedit in a supplied inert-document element',
    sourceKey: 'src/dom/tests/ui-declarations.browser.test.ts:248:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: uiDeclarationsFile,
    fullName:
      'terminal UI declarations > releases preedit cache and observer ownership when the optional element disappears',
    sourceKey: 'src/dom/tests/ui-declarations.browser.test.ts:257:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: uiDeclarationsFile,
    fullName:
      'terminal UI declarations > restores caret declarations after exposed inline styles change',
    sourceKey: 'src/dom/tests/ui-declarations.browser.test.ts:265:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: uiDeclarationsFile,
    fullName:
      'terminal UI declarations > restores preedit appearance after exposed inline styles change',
    sourceKey: 'src/dom/tests/ui-declarations.browser.test.ts:276:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: uiDeclarationsFile,
    fullName:
      'terminal UI declarations > restores preedit appearance after a peer callback in the same native frame',
    sourceKey: 'src/dom/tests/ui-declarations.browser.test.ts:284:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: uiDeclarationsFile,
    fullName:
      'terminal UI declarations > applies appearance to a replacement supplied composition element',
    sourceKey: 'src/dom/tests/ui-declarations.browser.test.ts:291:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: uiDeclarationsFile,
    fullName:
      'terminal UI declarations > retains preedit appearance during row edits with unchanged font and theme',
    sourceKey: 'src/dom/tests/ui-declarations.browser.test.ts:299:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: uiDeclarationsFile,
    fullName:
      'terminal UI declarations > keeps owned caret declarations until validated coordinates change',
    sourceKey: 'src/dom/tests/ui-declarations.browser.test.ts:336:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]

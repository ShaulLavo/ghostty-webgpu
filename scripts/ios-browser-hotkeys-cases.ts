import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const ghosttyKeymapFile = fileURLToPath(
  new URL('../src/extensions/hotkeys/tests/ghostty-keymap.browser.test.ts', import.meta.url),
)

export const ghosttyKeymapCases = [
  {
    file: ghosttyKeymapFile,
    fullName:
      'legacy Ghostty Mac keymap > sends five text actions with repeats and consumes releases',
    sourceKey: 'src/extensions/hotkeys/tests/ghostty-keymap.browser.test.ts:58:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: ghosttyKeymapFile,
    fullName:
      'kitty Ghostty Mac keymap > sends five text actions with repeats and consumes releases',
    sourceKey: 'src/extensions/hotkeys/tests/ghostty-keymap.browser.test.ts:58:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: ghosttyKeymapFile,
    fullName: 'passes composition and extra modifiers to native encoding',
    sourceKey: 'src/extensions/hotkeys/tests/ghostty-keymap.browser.test.ts:76:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: ghosttyKeymapFile,
    fullName: 'reads the screen-reader flag before each event and preserves browser defaults',
    sourceKey: 'src/extensions/hotkeys/tests/ghostty-keymap.browser.test.ts:90:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: ghosttyKeymapFile,
    fullName: 'allows an empty replacement keymap and keeps appended bindings',
    sourceKey: 'src/extensions/hotkeys/tests/ghostty-keymap.browser.test.ts:105:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: ghosttyKeymapFile,
    fullName: 'clears history and rows above the cursor while preserving the prompt and modes',
    sourceKey: 'src/extensions/hotkeys/tests/ghostty-keymap.browser.test.ts:125:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: ghosttyKeymapFile,
    fullName:
      'leaves alternate-screen content and selection intact even with an unconditional clear binding',
    sourceKey: 'src/extensions/hotkeys/tests/ghostty-keymap.browser.test.ts:142:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: ghosttyKeymapFile,
    fullName: 'scrolls by pages and to history edges on mac',
    sourceKey: 'src/extensions/hotkeys/tests/ghostty-keymap.browser.test.ts:156:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: ghosttyKeymapFile,
    fullName: 'scrolls by pages and to history edges on linux',
    sourceKey: 'src/extensions/hotkeys/tests/ghostty-keymap.browser.test.ts:156:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: ghosttyKeymapFile,
    fullName: 'scrolls by pages and to history edges on windows',
    sourceKey: 'src/extensions/hotkeys/tests/ghostty-keymap.browser.test.ts:156:2',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: ghosttyKeymapFile,
    fullName: 'flushes queued output before placing the prompt at the top',
    sourceKey: 'src/extensions/hotkeys/tests/ghostty-keymap.browser.test.ts:175:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: ghosttyKeymapFile,
    fullName: 'preserves an alternate screen entered by queued output before clear',
    sourceKey: 'src/extensions/hotkeys/tests/ghostty-keymap.browser.test.ts:184:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: ghosttyKeymapFile,
    fullName: 'matches the default clear binding after a queued alternate-screen exit',
    sourceKey: 'src/extensions/hotkeys/tests/ghostty-keymap.browser.test.ts:195:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]

import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const macKeybindingsFile = fileURLToPath(
  new URL('../src/dom/tests/mac-keybindings.browser.test.ts', import.meta.url),
)

export const macKeybindingsCases = [
  {
    file: macKeybindingsFile,
    fullName: 'preserves synchronous key hook ordering and screen-reader browser defaults',
    sourceKey: 'src/dom/tests/mac-keybindings.browser.test.ts:31:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: macKeybindingsFile,
    fullName: 'main macOS core without a keymap > encodes Cmd+Left through VT in legacy mode',
    sourceKey: 'src/dom/tests/mac-keybindings.browser.test.ts:93:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: macKeybindingsFile,
    fullName: 'main macOS core without a keymap > encodes Cmd+Left through VT in kitty mode',
    sourceKey: 'src/dom/tests/mac-keybindings.browser.test.ts:93:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: macKeybindingsFile,
    fullName: 'worker macOS core without a keymap > encodes Cmd+Left through VT in legacy mode',
    sourceKey: 'src/dom/tests/mac-keybindings.browser.test.ts:93:2',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: macKeybindingsFile,
    fullName: 'worker macOS core without a keymap > encodes Cmd+Left through VT in kitty mode',
    sourceKey: 'src/dom/tests/mac-keybindings.browser.test.ts:93:3',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: macKeybindingsFile,
    fullName: 'keeps linux keys on the VT encoder path',
    sourceKey: 'src/dom/tests/mac-keybindings.browser.test.ts:121:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: macKeybindingsFile,
    fullName: 'keeps windows keys on the VT encoder path',
    sourceKey: 'src/dom/tests/mac-keybindings.browser.test.ts:121:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: macKeybindingsFile,
    fullName: 'honors claims, disabled input, composition, extra modifiers, and key hooks',
    sourceKey: 'src/dom/tests/mac-keybindings.browser.test.ts:155:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]

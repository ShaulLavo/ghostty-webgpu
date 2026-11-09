import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const hotkeysFocusFile = fileURLToPath(
  new URL('../src/extensions/hotkeys/tests/focus.browser.test.ts', import.meta.url),
)

export const hotkeysFocusCases = [
  {
    file: hotkeysFocusFile,
    fullName:
      'main public hotkeys connection > rejects a JavaScript nonfunction before taking finite input ownership',
    sourceKey: 'src/extensions/hotkeys/tests/focus.browser.test.ts:136:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: hotkeysFocusFile,
    fullName:
      'main public hotkeys connection > reports a invalid decision and continues synchronously without retroactive claims',
    sourceKey: 'src/extensions/hotkeys/tests/focus.browser.test.ts:146:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: hotkeysFocusFile,
    fullName:
      'main public hotkeys connection > reports a resolved decision and continues synchronously without retroactive claims',
    sourceKey: 'src/extensions/hotkeys/tests/focus.browser.test.ts:146:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: hotkeysFocusFile,
    fullName:
      'main public hotkeys connection > reports a rejected decision and continues synchronously without retroactive claims',
    sourceKey: 'src/extensions/hotkeys/tests/focus.browser.test.ts:146:2',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: hotkeysFocusFile,
    fullName:
      'main public hotkeys connection > releases failed before-open attachment and its subscription',
    sourceKey: 'src/extensions/hotkeys/tests/focus.browser.test.ts:184:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: hotkeysFocusFile,
    fullName:
      'main public hotkeys connection > releases failed after-open attachment and its subscription',
    sourceKey: 'src/extensions/hotkeys/tests/focus.browser.test.ts:184:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: hotkeysFocusFile,
    fullName:
      'main public hotkeys connection > owns standalone hotkeys without constructing the general manager',
    sourceKey: 'src/extensions/hotkeys/tests/focus.browser.test.ts:218:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: hotkeysFocusFile,
    fullName:
      'main public hotkeys connection > owns hosted hotkeys without constructing the general manager',
    sourceKey: 'src/extensions/hotkeys/tests/focus.browser.test.ts:218:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: hotkeysFocusFile,
    fullName:
      'main public hotkeys connection > attaches before open and passes unbound input once while a shallower binding owns Ctrl+B',
    sourceKey: 'src/extensions/hotkeys/tests/focus.browser.test.ts:249:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: hotkeysFocusFile,
    fullName:
      'main public hotkeys connection > sends deeper shell pack press, repeat and release once with no original-input re-entry',
    sourceKey: 'src/extensions/hotkeys/tests/focus.browser.test.ts:268:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: hotkeysFocusFile,
    fullName:
      'main public hotkeys connection > reads confirmed alternate-screen and mouse context before matching each event',
    sourceKey: 'src/extensions/hotkeys/tests/focus.browser.test.ts:313:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: hotkeysFocusFile,
    fullName:
      'main public hotkeys connection > commits composing text once and lets native protocol replies bypass claims',
    sourceKey: 'src/extensions/hotkeys/tests/focus.browser.test.ts:341:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: hotkeysFocusFile,
    fullName:
      'main public hotkeys connection > keeps a mapped press owner across focus movement and forwards its release once',
    sourceKey: 'src/extensions/hotkeys/tests/focus.browser.test.ts:386:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: hotkeysFocusFile,
    fullName:
      'main public hotkeys connection > blur clears native ownership before a later release',
    sourceKey: 'src/extensions/hotkeys/tests/focus.browser.test.ts:407:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: hotkeysFocusFile,
    fullName:
      'main public hotkeys connection > hidden clears native ownership before a later release',
    sourceKey: 'src/extensions/hotkeys/tests/focus.browser.test.ts:407:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: hotkeysFocusFile,
    fullName:
      'main public hotkeys connection > releaseAll clears native ownership before a later release',
    sourceKey: 'src/extensions/hotkeys/tests/focus.browser.test.ts:407:2',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: hotkeysFocusFile,
    fullName:
      'main public hotkeys connection > dispose clears native ownership before a later release',
    sourceKey: 'src/extensions/hotkeys/tests/focus.browser.test.ts:407:3',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: hotkeysFocusFile,
    fullName:
      'main public hotkeys connection > linux standalone defaults and a user override work through the public factory',
    sourceKey: 'src/extensions/hotkeys/tests/focus.browser.test.ts:436:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: hotkeysFocusFile,
    fullName:
      'main public hotkeys connection > windows standalone defaults and a user override work through the public factory',
    sourceKey: 'src/extensions/hotkeys/tests/focus.browser.test.ts:436:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: hotkeysFocusFile,
    fullName:
      'main public hotkeys connection > mac standalone defaults and a user override work through the public factory',
    sourceKey: 'src/extensions/hotkeys/tests/focus.browser.test.ts:436:2',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: hotkeysFocusFile,
    fullName:
      'main public hotkeys connection > attaches after open, removes its node/commands, cancels clipboard completion and leaves native authority live',
    sourceKey: 'src/extensions/hotkeys/tests/focus.browser.test.ts:523:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]

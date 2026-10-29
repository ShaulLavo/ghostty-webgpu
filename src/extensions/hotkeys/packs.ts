import type { Binding, KeymapPlatform } from '@fregat/hotkeys'

function defaults(
  modifier: string,
  clipboardModifier: string,
  scrollModifier: string,
): readonly Binding[] {
  const bindings: readonly Binding[] = [
    { keys: `${clipboardModifier}+C`, command: 'terminal.copy' },
    { keys: `${clipboardModifier}+A`, command: 'terminal.selectAll' },
    {
      keys: `${clipboardModifier}+K`,
      command: 'terminal.clear',
      context: 'Terminal && mode == normal',
    },
    { keys: `${modifier}+=`, command: 'terminal.fontSizeIncrease' },
    { keys: `${modifier}+Shift++`, command: 'terminal.fontSizeIncrease' },
    { keys: `${modifier}+-`, command: 'terminal.fontSizeDecrease' },
    { keys: `${modifier}+0`, command: 'terminal.fontSizeReset' },
    { keys: `${scrollModifier}+Home`, command: 'terminal.scrollToTop' },
    { keys: `${scrollModifier}+End`, command: 'terminal.scrollToBottom' },
    { keys: `${scrollModifier}+PageUp`, command: 'terminal.scrollPageUp' },
    { keys: `${scrollModifier}+PageDown`, command: 'terminal.scrollPageDown' },
  ]
  return bindings.map((binding) => ({ context: 'Terminal', source: 'default', ...binding }))
}

const macTextBindings: readonly Binding[] = [
  { keys: 'Meta+ArrowLeft', command: 'terminal.sendKeystroke', args: { text: '\x01' } },
  { keys: 'Meta+ArrowRight', command: 'terminal.sendKeystroke', args: { text: '\x05' } },
  { keys: 'Meta+Backspace', command: 'terminal.sendKeystroke', args: { text: '\x15' } },
  { keys: 'Alt+ArrowLeft', command: 'terminal.sendKeystroke', args: { text: '\x1bb' } },
  { keys: 'Alt+ArrowRight', command: 'terminal.sendKeystroke', args: { text: '\x1bf' } },
].map((binding) => ({ ...binding, context: 'Terminal && screenReader == off', source: 'default' }))

export const ghosttyKeymap: Record<KeymapPlatform, readonly Binding[]> = {
  mac: defaults('Meta', 'Meta', 'Meta').concat(macTextBindings),
  linux: defaults('Ctrl', 'Ctrl+Shift', 'Shift'),
  windows: defaults('Ctrl', 'Ctrl+Shift', 'Shift'),
}

const controlLetters = Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ', (letter) => `Ctrl+${letter}`)
const readlineKeys = [
  'Alt+B',
  'Alt+F',
  'Alt+D',
  'Alt+Backspace',
  'Alt+Delete',
  'Alt+C',
  'Alt+L',
  'Alt+U',
  'Alt+T',
  'Alt+Y',
  'Alt+R',
  'Alt+<',
  'Alt+>',
  'Alt+.',
  'Alt+_',
  'Alt+?',
  'Alt+/',
  'Alt+\\',
  'Alt+#',
  'Alt+*',
  'Alt+~',
]

export const terminalShellKeysPack: readonly Binding[] = controlLetters
  .concat(readlineKeys)
  .map((keys) => ({
    keys,
    command: 'terminal.sendKeystroke',
    args: { keystroke: keys },
    context: 'Terminal',
    source: 'pack',
  }))

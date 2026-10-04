import type { Binding, KeymapPlatform } from '@fregat/hotkeys'

function defaults(modifier: string, clipboardModifier: string): readonly Binding[] {
  return [
    { keys: `${clipboardModifier}+C`, command: 'terminal.copy' },
    { keys: `${clipboardModifier}+V`, command: 'terminal.paste' },
    { keys: `${clipboardModifier}+A`, command: 'terminal.selectAll' },
    { keys: `${clipboardModifier}+K`, command: 'terminal.clear' },
    { keys: `${modifier}+=`, command: 'terminal.fontSizeIncrease' },
    { keys: `${modifier}+Shift++`, command: 'terminal.fontSizeIncrease' },
    { keys: `${modifier}+-`, command: 'terminal.fontSizeDecrease' },
    { keys: `${modifier}+0`, command: 'terminal.fontSizeReset' },
  ].map((binding) => ({ ...binding, context: 'Terminal', source: 'default' }))
}

export const terminalDefaultPack: Readonly<Record<KeymapPlatform, readonly Binding[]>> = {
  mac: defaults('Meta', 'Meta'),
  linux: defaults('Ctrl', 'Ctrl+Shift'),
  windows: defaults('Ctrl', 'Ctrl+Shift'),
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

export const terminalShellKeysPack: readonly Binding[] = [...controlLetters, ...readlineKeys].map(
  (keys) => ({
    keys,
    command: 'terminal.sendKeystroke',
    args: { keystroke: keys },
    context: 'Terminal',
    source: 'pack',
  }),
)

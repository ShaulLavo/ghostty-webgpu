import { expect, it } from 'vitest'
import { createKeyInput, createDispatcher } from '@fregat/hotkeys'
import { terminalKeyContext } from '../context.js'
import { readSendKeystrokeArgs, terminalKeystroke } from '../keystroke.js'
import { ghosttyKeymap, terminalShellKeysPack } from '../packs.js'
import { TerminalSession } from '../../../term/session.js'

it('native encoding covers Ctrl letters and readline keys from the exported pack', async () => {
  const session = await TerminalSession.create()
  try {
    const controls = terminalShellKeysPack.slice(0, 26).map((row) => {
      const args = readSendKeystrokeArgs(row.args)
      if (!args || !('keystroke' in args)) return null
      const input = terminalKeystroke(args.keystroke, 'linux')
      return input ? Array.from(session.key(input)) : null
    })
    const expected = Array.from({ length: 26 }, (_, index) => [index + 1])
    expected[8] = Array.from(new TextEncoder().encode('\u001b[105;5u'))
    expected[12] = Array.from(new TextEncoder().encode('\u001b[109;5u'))
    expect(controls).toEqual(expected)
    for (const row of terminalShellKeysPack.slice(26)) {
      const args = readSendKeystrokeArgs(row.args)
      if (!args || !('keystroke' in args)) throw new TypeError('Missing pack keystroke')
      const input = terminalKeystroke(args.keystroke, 'linux')
      expect(input, args.keystroke).not.toBeNull()
      if (input) expect(session.key(input).length, args.keystroke).toBeGreaterThan(0)
    }
  } finally {
    session.dispose()
  }
})

it('encodes generated shifted letters and space with native printable text', async () => {
  const session = await TerminalSession.create()
  try {
    for (const [keys, text] of [
      ['shift-a', 'A'],
      ['space', ' '],
    ] as const) {
      const input = terminalKeystroke(keys, 'linux')
      expect(input).not.toBeNull()
      if (input) expect(new TextDecoder().decode(session.key(input))).toBe(text)
    }
  } finally {
    session.dispose()
  }
})

it('accepts Zed strokes and rejects malformed or ambiguous payloads', () => {
  expect(terminalKeystroke('ctrl-b', 'linux')).toMatchObject({
    action: 'press',
    code: 'KeyB',
    text: 'b',
    modifiers: { control: 'unknown' },
  })
  expect(terminalKeystroke('up', 'mac')?.code).toBe('ArrowUp')
  expect(terminalKeystroke('pageup', 'windows')?.code).toBe('PageUp')
  for (const keys of ['', 'Ctrl+B Ctrl+C', 'unknown+B', 'NoSuchKey'])
    expect(terminalKeystroke(keys, 'linux')).toBeNull()
  for (const args of [
    undefined,
    null,
    'ctrl-b',
    {},
    { text: 1 },
    { text: 'a', keystroke: 'ctrl-a' },
    { text: 'a', extra: true },
  ])
    expect(readSendKeystrokeArgs(args)).toBeNull()
  expect(readSendKeystrokeArgs({ text: '\u001bb' })).toEqual({ text: '\u001bb' })
  expect(readSendKeystrokeArgs({ keystroke: 'ctrl-b' })).toEqual({ keystroke: 'ctrl-b' })
})

it.each(['mac', 'linux', 'windows'] as const)('defaults are overridable on %s', (platform) => {
  const calls: string[] = []
  const dispatcher = createDispatcher<null>({
    platform,
    keymap: ghosttyKeymap[platform].concat([
      {
        keys: platform === 'mac' ? 'Meta+C' : 'Ctrl+Shift+C',
        command: 'terminal.clear',
        context: 'Terminal',
        source: 'user',
      },
    ]),
  })
  const node = dispatcher.createNode({
    context: terminalKeyContext({
      alternateScreen: false,
      mouseReporting: false,
      screenReader: false,
    }),
    commands: {
      'terminal.copy': () => void calls.push('copy'),
      'terminal.clear': () => void calls.push('clear'),
    },
  })
  node.focus()
  dispatcher.handleKey(
    createKeyInput({
      key: 'c',
      code: 'KeyC',
      modifiers: {
        meta: platform === 'mac',
        ctrl: platform !== 'mac',
        shift: platform !== 'mac',
      },
    }),
    null,
  )
  expect(calls).toEqual(['clear'])
  dispatcher.dispose()
})

it('exports Ghostty text actions only on Mac and leaves browser paste unbound', () => {
  expect(
    ghosttyKeymap.mac.filter((binding) => binding.command === 'terminal.sendKeystroke'),
  ).toEqual(
    [
      ['Meta+ArrowLeft', '\x01'],
      ['Meta+ArrowRight', '\x05'],
      ['Meta+Backspace', '\x15'],
      ['Alt+ArrowLeft', '\x1bb'],
      ['Alt+ArrowRight', '\x1bf'],
    ].map(([keys, text]) => ({
      keys,
      command: 'terminal.sendKeystroke',
      args: { text },
      context: 'Terminal && screenReader == off',
      source: 'default',
    })),
  )
  for (const platform of ['mac', 'linux', 'windows'] as const) {
    expect(ghosttyKeymap[platform].some((binding) => binding.command === 'terminal.paste')).toBe(
      false,
    )
    expect(
      ghosttyKeymap[platform].find((binding) => binding.command === 'terminal.clear')?.context,
    ).toBe('Terminal && mode == normal')
  }
  expect(ghosttyKeymap.linux.some((binding) => binding.command === 'terminal.sendKeystroke')).toBe(
    false,
  )
  expect(
    ghosttyKeymap.windows.some((binding) => binding.command === 'terminal.sendKeystroke'),
  ).toBe(false)
})

it.each(['mac', 'linux', 'windows'] as const)(
  'exports native scroll bindings on %s',
  (platform) => {
    const modifier = platform === 'mac' ? 'Meta' : 'Shift'
    expect(
      ghosttyKeymap[platform].filter((binding) => binding.command?.startsWith('terminal.scroll')),
    ).toEqual(
      [
        ['Home', 'terminal.scrollToTop'],
        ['End', 'terminal.scrollToBottom'],
        ['PageUp', 'terminal.scrollPageUp'],
        ['PageDown', 'terminal.scrollPageDown'],
      ].map(([key, command]) => ({
        keys: `${modifier}+${key}`,
        command,
        context: 'Terminal',
        source: 'default',
      })),
    )
  },
)

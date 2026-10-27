import type { Terminal } from 'ghostty-webgpu'

export const migration = [
  [
    'new Terminal(options)',
    'await Terminal.create(options)',
    'Creation loads wasm asynchronously.',
  ],
  ['open(host)', 'open', 'Await opening; the host must have a size.'],
  [
    'write(data, callback)',
    'write',
    'Synchronous result on the main entry; promise in the worker.',
  ],
  ['writeln(data)', 'writeln', 'Write a line through native parsing.'],
  ['onData / onBinary', 'onData', 'The listener receives Uint8Array bytes.'],
  ['onResize', 'onResize', 'The event has cols and rows.'],
  ['onTitleChange / onBell', 'on', 'Subscribe to title and bell events.'],
  ['onRender', 'onFrame', 'Observe submitted rows.'],
  ['FitAddon.fit()', 'setAppearance', 'Automatic fit; set appearance.grid for explicit geometry.'],
  ['options.theme', 'setTheme', 'RGB objects and a 256-entry palette.'],
  ['options.fontFamily / fontSize', 'setFont', 'A partial native font object.'],
  ['options.cursorStyle / cursorBlink', 'setCursor', 'A partial native cursor object.'],
  ['buffer.active.length', 'lineCount', 'Counts retained history and active visible rows.'],
  ['buffer.getLine(i)', 'readLines', 'Half-open ranges, capped at 1,024 rows.'],
  ['getSelection()', 'getSelection', 'Choose plain, VT or HTML formatting.'],
  ['select / selectAll', 'selectRange', 'Native coordinates; selectAll is also available.'],
  ['scrollLines', 'scrollBy', 'Scroll by a row delta.'],
  ['scrollToLine', 'scrollToRow', 'Scroll to a retained row.'],
  ['loadAddon(addon)', 'use', 'Install a native extension.'],
  ['registerLinkProvider', 'registerLinkProvider', 'URL and OSC 8 detection are built in.'],
  [
    'attachCustomKeyEventHandler',
    'connectInput',
    'Synchronous claim/pass ownership on the main entry.',
  ],
  [
    'focus / blur / dispose',
    'dispose',
    'Focus and blur stay synchronous; dispose returns a promise in the worker.',
  ],
] as const satisfies readonly (readonly [
  string,
  keyof Terminal | 'await Terminal.create(options)',
  string,
])[]

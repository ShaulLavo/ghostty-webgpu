export interface KeyStroke {
  readonly key: string
  readonly ctrl?: boolean
  readonly alt?: boolean
  readonly shift?: boolean
  readonly meta?: boolean
}

export type Action =
  | 'left'
  | 'right'
  | 'start'
  | 'end'
  | 'word-left'
  | 'word-right'
  | 'backspace'
  | 'delete'
  | 'kill-word'
  | 'kill-start'
  | 'kill-end'
  | 'yank'
  | 'previous'
  | 'next'
  | 'search'
  | 'cancel-search'
  | 'clear'
  | 'eof'
  | 'interrupt'
  | 'complete'
  | 'submit'
  | 'newline'
export type EditCommand =
  | { readonly kind: Action }
  | { readonly kind: 'insert'; readonly text: string }

const plain: Readonly<Record<string, Action>> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Home: 'start',
  End: 'end',
  ArrowUp: 'previous',
  ArrowDown: 'next',
  Backspace: 'backspace',
  Delete: 'delete',
  Enter: 'submit',
  Tab: 'complete',
  Escape: 'cancel-search',
}
const control: Readonly<Record<string, Action>> = {
  a: 'start',
  e: 'end',
  b: 'left',
  f: 'right',
  w: 'kill-word',
  u: 'kill-start',
  k: 'kill-end',
  y: 'yank',
  l: 'clear',
  d: 'eof',
  c: 'interrupt',
  r: 'search',
  g: 'cancel-search',
  ArrowLeft: 'word-left',
  ArrowRight: 'word-right',
}
const alt: Readonly<Record<string, Action>> = { b: 'word-left', f: 'word-right', Enter: 'newline' }

export function keyCommand(stroke: KeyStroke): EditCommand | undefined {
  if (stroke.meta || (stroke.ctrl && stroke.alt)) return undefined
  if (stroke.shift && (stroke.ctrl || stroke.alt)) return undefined
  if (stroke.key === 'Enter' && stroke.shift) return { kind: 'newline' }
  if (stroke.shift && [...stroke.key].length !== 1) return undefined
  if (stroke.ctrl)
    return action(control[stroke.key.length === 1 ? stroke.key.toLowerCase() : stroke.key])
  if (stroke.alt) return action(alt[stroke.key])
  const command = plain[stroke.key]
  if (command) return { kind: command }
  if ([...stroke.key].length === 1 && stroke.key >= ' ') return { kind: 'insert', text: stroke.key }
  return undefined
}

function action(kind: Action | undefined): EditCommand | undefined {
  return kind ? { kind } : undefined
}

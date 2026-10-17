import { expect, test } from 'vitest'
import { keyCommand } from '../keymap.js'

test.each([
  ['ArrowLeft', {}, 'left'],
  ['ArrowRight', {}, 'right'],
  ['Home', {}, 'start'],
  ['End', {}, 'end'],
  ['Backspace', {}, 'backspace'],
  ['Delete', {}, 'delete'],
  ['a', { ctrl: true }, 'start'],
  ['e', { ctrl: true }, 'end'],
  ['b', { ctrl: true }, 'left'],
  ['f', { ctrl: true }, 'right'],
  ['b', { alt: true }, 'word-left'],
  ['f', { alt: true }, 'word-right'],
  ['ArrowLeft', { ctrl: true }, 'word-left'],
  ['ArrowRight', { ctrl: true }, 'word-right'],
  ['w', { ctrl: true }, 'kill-word'],
  ['u', { ctrl: true }, 'kill-start'],
  ['k', { ctrl: true }, 'kill-end'],
  ['y', { ctrl: true }, 'yank'],
  ['l', { ctrl: true }, 'clear'],
  ['d', { ctrl: true }, 'eof'],
  ['c', { ctrl: true }, 'interrupt'],
  ['r', { ctrl: true }, 'search'],
  ['ArrowUp', {}, 'previous'],
  ['ArrowDown', {}, 'next'],
  ['Tab', {}, 'complete'],
  ['Enter', {}, 'submit'],
  ['Enter', { shift: true }, 'newline'],
  ['Escape', {}, 'cancel-search'],
  ['g', { ctrl: true }, 'cancel-search'],
] as const)('%s maps to %s', (key, modifiers, command) => {
  expect(keyCommand({ key, ...modifiers })).toEqual({ kind: command })
})

test('printable Unicode is inserted while browser command chords stay unclaimed', () => {
  expect(keyCommand({ key: '界' })).toEqual({ kind: 'insert', text: '界' })
  expect(keyCommand({ key: 'v', meta: true })).toBeUndefined()
  expect(keyCommand({ key: 'v', ctrl: true })).toBeUndefined()
  expect(keyCommand({ key: 'F1' })).toBeUndefined()
})

test.each([
  { key: 'C', ctrl: true, shift: true },
  { key: 'L', ctrl: true, shift: true },
  { key: 'ArrowLeft', ctrl: true, shift: true },
  { key: 'b', alt: true, shift: true },
  { key: 'Tab', shift: true },
  { key: 'ArrowLeft', shift: true },
])('shifted unbound command %j stays unclaimed', (stroke) => {
  expect(keyCommand(stroke)).toBeUndefined()
})

test('Shift preserves printable text and explicitly bound newline commands', () => {
  expect(keyCommand({ key: 'A', shift: true })).toEqual({ kind: 'insert', text: 'A' })
  expect(keyCommand({ key: 'Enter', shift: true })).toEqual({ kind: 'newline' })
  expect(keyCommand({ key: 'Enter', alt: true })).toEqual({ kind: 'newline' })
})

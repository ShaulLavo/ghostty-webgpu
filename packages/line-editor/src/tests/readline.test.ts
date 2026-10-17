import type {
  TerminalGeometry,
  TerminalMutationResult,
  TerminalTextMeasurement,
} from 'ghostty-webgpu'
import { expect, test } from 'vitest'
import { ReadSession } from '../session.js'
import { ReadlineRenderer, type ReadlineTerminal } from '../readline.js'

const geometry: TerminalGeometry = {
  revision: 1,
  columns: 80,
  rows: 24,
  cellWidth: 8,
  cellHeight: 16,
  cursor: { pendingWrap: false, visible: true, x: 0, y: 0 },
  scrollbar: { length: 24, offset: 0, total: 24 },
  graphemeClustering: true,
  autowrap: true,
}

function fakeTerminal(writes: string[]): ReadlineTerminal {
  const measureTexts = (texts: readonly string[]): TerminalTextMeasurement => ({
    geometry,
    texts: texts.map((text) => ({ cells: [...text].length, units: [] })),
  })
  const write = (data: string | Uint8Array): TerminalMutationResult => {
    writes.push(typeof data === 'string' ? data : new TextDecoder().decode(data))
    return { revision: writes.length }
  }
  return { geometry: () => geometry, measureTexts, write } satisfies ReadlineTerminal
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

test('renders a read and leaves the submitted line above the next cursor', async () => {
  const writes: string[] = []
  const terminal = fakeTerminal(writes)
  let renderer: ReadlineRenderer
  const session = new ReadSession({}, (event) => renderer.handle(event))
  renderer = new ReadlineRenderer(terminal, session, undefined)

  const pending = session.read({ prompt: '$ ' })
  await settle()
  await session.dispatch({ kind: 'insert', text: 'echo hi' })
  await settle()
  await session.dispatch({ kind: 'submit' })
  const result = await pending
  renderer.finish(result)
  expect(result).toEqual({ kind: 'submit', text: 'echo hi' })
  await settle()

  expect(writes.join('')).toContain('$ echo hi\r\n')
})

test('prints output above an active prompt and restores the edit line', async () => {
  const writes: string[] = []
  const terminal = fakeTerminal(writes)
  let renderer: ReadlineRenderer
  const session = new ReadSession({}, (event) => renderer.handle(event))
  renderer = new ReadlineRenderer(terminal, session, undefined)

  session.read({ prompt: '$ ' })
  await settle()
  await session.dispatch({ kind: 'insert', text: 'typed' })
  await settle()
  renderer.print('output\r\n')
  await settle()

  expect(writes.join('')).toContain('output\r\n')
  expect(writes.at(-1)).toContain('$ typed')
})

test('normalizes printed line endings without disturbing a rejected second read', async () => {
  const writes: string[] = []
  const terminal = fakeTerminal(writes)
  let renderer: ReadlineRenderer
  const session = new ReadSession({}, (event) => renderer.handle(event))
  renderer = new ReadlineRenderer(terminal, session, undefined)

  session.read({ prompt: '$ ' })
  await settle()
  await expect(session.read({ prompt: '> ' })).rejects.toMatchObject({
    code: 'line-editor.READ_PENDING',
  })
  renderer.print('one\ntwo')
  await settle()

  expect(writes.join('')).toContain('one\r\ntwo\r\n')
  expect(session.active).toBe(true)
})

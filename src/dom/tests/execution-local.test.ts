import { afterEach, describe, expect, it } from 'vitest'
import { TerminalSession } from '../../term/session.js'
import type { TerminalClipboardWrite } from '../../term/types.js'
import { LocalTerminalExecution } from '../execution-local.js'
import { calculateTerminalFittedFont } from '../fit.js'

const cleanups: Array<() => void> = []
const decoder = new TextDecoder()

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

describe('local terminal execution owner', () => {
  it('preserves native encoding notification before ordered data delivery and return', async () => {
    const execution = await LocalTerminalExecution.create({})
    cleanups.push(() => execution.dispose())
    const order: string[] = []
    execution.on('data', ({ bytes }) => order.push(`data:${decoder.decode(bytes)}`))
    const bytes = execution.input.key(
      { action: 'press', code: 'KeyA', composing: false, text: 'a' },
      { onEncoded: (encoded) => order.push(`encoded:${decoder.decode(encoded)}`) },
    )
    order.push(`return:${decoder.decode(bytes)}`)
    expect(order).toEqual(['encoded:a', 'data:a', 'return:a'])

    execution.write('\u001b[5n')
    expect(order.at(-1)).toBe('data:\u001b[0n')
  })

  it('preserves the native write-only OSC52 read-query output before and after extraction', async () => {
    const native = await TerminalSession.create<Event>()
    const execution = await LocalTerminalExecution.create({})
    cleanups.push(
      () => native.dispose(),
      () => execution.dispose(),
    )
    const before: number[][] = []
    const after: number[][] = []
    native.on('data', ({ bytes }) => before.push(Array.from(bytes)))
    execution.on('data', ({ bytes }) => after.push(Array.from(bytes)))
    // A native status query proves both byte observers are attached before testing no read reply.
    native.write('\u001b[5n')
    execution.write('\u001b[5n')
    expect(after).toEqual(before)
    expect(after).toEqual([[27, 91, 48, 110]])
    before.length = 0
    after.length = 0

    native.write('\u001b]52;c;?\u0007')
    execution.write('\u001b]52;c;?\u0007')
    expect(after).toEqual(before)
    expect(after).toEqual([])
    const writes: TerminalClipboardWrite[] = []
    execution.setClipboardWritePolicy((write) => {
      writes.push(write)
      return 'success'
    })
    execution.write('\u001b]52;c;?\u0007')
    expect(writes).toEqual([])
    expect(after).toEqual([])
  })

  it('keeps default denial, copied clipboard payloads and policy errors with the owner', async () => {
    const execution = await LocalTerminalExecution.create({})
    cleanups.push(() => execution.dispose())
    const errors: Array<{ cause: unknown; operation: string }> = []
    const writes: TerminalClipboardWrite[] = []
    execution.on('error', (error) => errors.push(error))
    execution.write('\u001b]52;c;ZGVuaWVk\u0007')
    expect(errors).toEqual([])
    execution.setClipboardWritePolicy((write) => {
      writes.push(write)
      return 'success'
    })
    execution.write('\u001b]52;c;Y29waWVk\u0007')
    execution.write('\u001b]52;c;cmVwbGFjZWQ=\u0007')
    expect(decoder.decode(writes[0]!.contents[0]!.data)).toBe('copied')
    expect(decoder.decode(writes[1]!.contents[0]!.data)).toBe('replaced')
    execution.write('\u001b]52;c;%%%\u0007')
    expect(writes).toHaveLength(2)
    const failure = new TypeError('Policy rejected the write')
    execution.setClipboardWritePolicy(() => {
      throw failure
    })
    execution.write('\u001b]52;c;ZmFpbA==\u0007')
    expect(errors).toEqual([{ cause: failure, operation: 'clipboardWrite' }])
  })

  it('submits renderer cell metrics before the first native fit and owns the visible text', async () => {
    const session = await TerminalSession.create<Event>()
    const execution = new LocalTerminalExecution(session)
    cleanups.push(() => execution.dispose())
    const font = calculateTerminalFittedFont(
      session.appearance.font,
      { advanceWidth: 10, fontAscent: 16, fontDescent: 4 },
      2,
    )
    expect(session.grid.cellWidth).not.toBe(font.cssCellWidth)
    execution.commitLayout(font, { bottom: 0, left: 3, right: 0, top: 4 })
    execution.write('initial')
    session.renderState.update()
    execution.submit({ cursor: session.renderState.readCursor(), rows: [] })
    const summary = execution.submittedFrame!
    expect(summary.grid).toMatchObject({
      cellHeight: font.cssCellHeight,
      cellWidth: font.cssCellWidth,
      columns: session.grid.columns,
      pixelRatio: font.pixelRatio,
      rows: session.grid.rows,
    })
    expect(summary.rows[0]?.text.trimEnd()).toBe('initial')
    execution.write('\rchanged')
    session.renderState.update()
    expect(execution.submittedFrame).toBe(summary)
    expect(execution.textFrame()?.rows[0]?.text.trimEnd()).toBe('initial')
    expect(execution.captureViewport(800, 400)).toBeUndefined()
    execution.resize({ columns: session.grid.columns + 1, rows: session.grid.rows - 1 })
    session.renderState.update()
    execution.submit({ cursor: session.renderState.readCursor(), rows: [] })
    const resized = execution.submittedFrame!
    expect(resized.layout).toBeGreaterThan(summary.layout)
    expect(resized.rowPatches).toHaveLength(resized.grid.rows)
    expect(resized.grid.columns).toBe(summary.grid.columns + 1)
    expect(resized.grid.rows).toBe(summary.grid.rows - 1)
    expect(resized.font).toBe(font)
  })

  it('keeps live native measurements and atomic prompt geometry with the submitted owner', async () => {
    const session = await TerminalSession.create<Event>({
      appearance: { grid: { columns: 6, rows: 3, cellWidth: 10, cellHeight: 20 } },
    })
    const execution = new LocalTerminalExecution(session)
    cleanups.push(() => execution.dispose())
    const font = calculateTerminalFittedFont(
      session.appearance.font,
      { advanceWidth: 10, fontAscent: 16, fontDescent: 4 },
      1,
    )
    execution.commitLayout(font, { bottom: 0, left: 0, right: 0, top: 0 })
    session.renderState.update()
    execution.submit({ cursor: session.renderState.readCursor(), rows: [] })
    const displayed = execution.submittedFrame

    execution.write('\x1b[?2027h')
    const texts: readonly string[] = ['👩‍💻中é✈️', '']
    const measured = execution.measureTexts(texts)
    expect(measured.texts.map((text) => text.cells)).toEqual([7, 0])
    expect(execution.measure(texts[0]!)).toBe(7)
    expect(measured.geometry).toEqual(session.geometry())
    expect(execution.geometry()).toEqual(session.geometry())

    execution.on('title', () => execution.write('later'))
    const origin = execution.writeAndReadGeometry('\x1b[32m中> \x1b[0m\x1b]0;prompt\x07')
    expect(origin.cursor).toMatchObject({ x: 4, y: 0, pendingWrap: false })
    expect(origin.revision).toBeLessThan(execution.revision)
    expect(execution.geometry()).toEqual(session.geometry())
    expect(execution.geometry().cursor).not.toEqual(origin.cursor)
    expect(execution.submittedFrame).toBe(displayed)
    expect(execution.captureViewport(60, 60)).toBeUndefined()

    execution.dispose()
    expect(() => execution.geometry()).toThrow('disposed')
    expect(() => execution.measure('late')).toThrow('disposed')
    expect(() => execution.measureTexts(texts)).toThrow('disposed')
    expect(() => execution.writeAndReadGeometry('late')).toThrow('disposed')
  })

  it('invalidates native actions synchronously and disposes idempotently', async () => {
    const execution = await LocalTerminalExecution.create({})
    execution.dispose()
    execution.dispose()
    expect(execution.submittedFrame).toBeUndefined()
    expect(() => execution.write('late')).toThrow()
    expect(() => execution.input.paste('late')).toThrow()
    expect(() => execution.pointer.resetMouseTracking()).toThrow()
    expect(() => execution.lineCount()).toThrow()
  })
})

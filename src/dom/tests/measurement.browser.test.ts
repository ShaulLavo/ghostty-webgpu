import { afterEach, describe, expect, it } from 'vitest'
import { DomTerminalRenderer, Terminal } from '../../index.js'
import type { TerminalGeometry } from '../../index.js'

const terminals: Terminal[] = []
const hosts: HTMLElement[] = []

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose()
  for (const host of hosts.splice(0)) host.remove()
})

async function openTerminal(): Promise<Terminal> {
  const host = document.createElement('div')
  host.style.width = '320px'
  host.style.height = '120px'
  document.body.append(host)
  hosts.push(host)
  const terminal = await Terminal.create({ rendererFactory: DomTerminalRenderer.create })
  terminals.push(terminal)
  await terminal.open(host)
  return terminal
}

describe('public native width and geometry hooks', () => {
  it('measures a readonly batch through the public entry and live native modes', async () => {
    const terminal = await openTerminal()
    terminal.write('\x1b[?2027h')
    const texts: readonly string[] = ['👩‍💻中é✈️', '']
    const result = terminal.measureTexts(texts)
    expect(result.texts[0]?.cells).toBe(7)
    expect(result.texts[0]?.units.map((unit) => [unit.start, unit.end])).toEqual([
      [0, 5],
      [5, 6],
      [6, 8],
      [8, 10],
    ])
    expect(result.geometry.revision).toBe(terminal.geometry().revision)
    expect(result.geometry.graphemeClustering).toBe(true)
    terminal.write('\x1b[?2027l')
    expect(terminal.measure('👩‍💻')).toBe(4)
    expect(terminal.geometry().graphemeClustering).toBe(false)
  })

  it.each(['title', 'data'] as const)(
    'publishes ordinary write geometry before public %s observers',
    async (event) => {
      const terminal = await openTerminal()
      const before = terminal.geometry()
      let observed: TerminalGeometry | undefined
      terminal.on(event, () => {
        observed = terminal.geometry()
      })
      terminal.write(event === 'title' ? 'abc\x1b]0;revision\x07' : 'abc\x1b[6n')
      expect(observed?.cursor.x).toBe(3)
      expect(observed?.revision).toBeGreaterThan(before.revision)
      expect(observed).toEqual(terminal.geometry())
    },
  )

  it('captures the native colored prompt origin before host title observers run', async () => {
    const terminal = await openTerminal()
    const order: string[] = []
    terminal.on('title', () => {
      order.push('observer')
      terminal.write('later')
    })
    const origin = terminal.writeAndReadGeometry('\x1b[32m中> \x1b[0m\x1b]0;prompt\x07')
    order.push('return')
    expect(order).toEqual(['observer', 'return'])
    expect(origin.cursor).toMatchObject({ x: 4, y: 0, pendingWrap: false })
    expect(terminal.geometry().cursor.x).toBe(9)
    expect(origin.revision).toBeLessThan(terminal.geometry().revision)
    expect(origin.cellWidth).toBe(terminal.appearance.grid.cellWidth)
    expect(origin.cellHeight).toBe(terminal.appearance.grid.cellHeight)
    expect(Object.isFrozen(origin)).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { GhosttyRuntime } from '../../core/runtime.js'
import { snapshotRenderState } from '../frame.js'
import { renderFrameToHtml } from './renderer.js'
import { probeFont, probeInput } from './tests/probe.js'

// The browser test renders this same real-core input and compares its live markup to this serializer.
describe('Node terminal HTML', () => {
  it('serializes styled real-core rows without DOM globals and escapes terminal text', async () => {
    expect(typeof document).toBe('undefined')
    const runtime = await GhosttyRuntime.create()
    try {
      const terminal = runtime.createTerminal({ columns: 12, rows: 3 })
      const state = runtime.createRenderState(terminal)
      terminal.write(probeInput)
      const snapshot = snapshotRenderState(state)
      const html = renderFrameToHtml(snapshot, { columns: 12, rows: 3, font: probeFont })
      expect(html).toContain('data-cursor="block"')
      expect(html).toContain('rgb(10, 20, 30)')
      expect(html).toContain('rgb(40, 50, 60)')
      expect(html).toContain('界')
      expect(html).toContain('é&lt;&amp;"')
      expect(html.match(/data-row=/g)).toHaveLength(3)
      expect(Object.isFrozen(snapshot.rows[0]!.renderCells[0]!.style)).toBe(true)
      const before = html
      terminal.write('\x1b[2Jchanged')
      state.update()
      expect(renderFrameToHtml(snapshot, { columns: 12, rows: 3, font: probeFont })).toBe(before)
    } finally {
      runtime.dispose()
    }
  })

  it('rejects CSS declarations in a font family and preserves quoted fallback lists', async () => {
    const runtime = await GhosttyRuntime.create()
    try {
      const terminal = runtime.createTerminal({ columns: 2, rows: 1 })
      const snapshot = snapshotRenderState(runtime.createRenderState(terminal))
      const font = (family: string) => ({
        ...probeFont,
        settings: { ...probeFont.settings, family },
      })
      for (const family of [
        'monospace;background-image:url(https://example.test)',
        'monospace/*',
        '"unclosed',
        'monospace\ncolor:red',
      ]) {
        expect(() =>
          renderFrameToHtml(snapshot, { columns: 2, rows: 1, font: font(family) }),
        ).toThrow(TypeError)
      }
      expect(
        renderFrameToHtml(snapshot, {
          columns: 2,
          rows: 1,
          font: font('"JetBrains Mono", monospace'),
        }),
      ).toContain('font-family:&quot;JetBrains Mono&quot;, monospace;')
    } finally {
      runtime.dispose()
    }
  })

  it('rejects invalid geometry', async () => {
    const runtime = await GhosttyRuntime.create()
    try {
      const terminal = runtime.createTerminal({ columns: 2, rows: 1 })
      const snapshot = snapshotRenderState(runtime.createRenderState(terminal))
      expect(() => renderFrameToHtml(snapshot, { columns: 0, rows: 1, font: probeFont })).toThrow(
        RangeError,
      )
    } finally {
      runtime.dispose()
    }
  })
})

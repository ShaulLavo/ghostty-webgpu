import { expect, test } from 'vitest'
import { GhosttyRuntime } from '../../src/core/runtime.js'
import { snapshotRenderState } from '../../src/render/frame.js'
import { renderFrameToHtml } from '../../src/render/dom/html.js'
import { probeFont } from '../../src/render/dom/tests/probe.js'
import { compactGhostHtml } from './first-frame-html.js'

test('compacts real-core ASCII rows into one grid with paint-only runs', async () => {
  const runtime = await GhosttyRuntime.create()
  try {
    const terminal = runtime.createTerminal({ columns: 8, rows: 2 })
    terminal.write('\x1b[?25l\x1b[38;2;10;20;30m<&  A\r\n<&  B')
    const html = compactGhostHtml(
      renderFrameToHtml(snapshotRenderState(runtime.createRenderState(terminal)), {
        columns: 8,
        rows: 2,
        font: probeFont,
      }),
    )
    expect(html.match(/<pre /g)).toHaveLength(1)
    expect(html.match(/data-row=/g)).toHaveLength(2)
    expect(html).toContain('&lt;&amp;')
    expect(html).toContain('</span>\n<span data-row="1">')
    expect(html).toContain('rgb(10, 20, 30)')
    expect(html).toContain('direction:ltr;unicode-bidi:bidi-override')
    expect(html).not.toMatch(/<span[^>]*style=/)
    const paint = html.slice(0, html.indexOf('</style>'))
    expect(paint).not.toMatch(/width|height|position|calc\(/)
  } finally {
    runtime.dispose()
  }
})

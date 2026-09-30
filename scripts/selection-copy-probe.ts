import { deepStrictEqual } from 'node:assert'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { swiftShaderArgs, swiftShaderEnv } from './swiftshader-launch.js'

// CPU-side copy costs only; SwiftShader lets the same headless Chromium launch everywhere.
// Run after build: bun scripts/selection-copy-probe.ts <output.json> [baseline.json]
const output = process.argv[2]
if (!output) throw new Error('Provide an output JSON path')
const root = resolve(import.meta.dirname, '..')
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/') return new Response('<!doctype html><title>Selection copy probe</title>')
    if (!path.startsWith('/dist/') && !path.endsWith('.wasm'))
      return new Response(null, { status: 404 })
    return new Response(Bun.file(resolve(root, `.${path}`)))
  },
})
const browser = await chromium.launch({ args: [...swiftShaderArgs], env: swiftShaderEnv() })
try {
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.port}`)
  const fixtures = await page.evaluate(async () => {
    const { GhosttyRuntime } = (await import(
      `${location.origin}/dist/core/runtime.js`
    )) as typeof import('../src/core/runtime.js')
    const { GhosttySelectionGesture } = (await import(
      `${location.origin}/dist/core/selection.js`
    )) as typeof import('../src/core/selection.js')
    const { TerminalOption, TerminalData, GhosttyResult } = (await import(
      `${location.origin}/dist/core/abi.js`
    )) as typeof import('../src/core/abi.js')
    const results = []
    for (const retainedRows of [1025, 50001]) {
      const runtime = await GhosttyRuntime.create()
      const terminal = runtime.createTerminal({ columns: 80, rows: 24 })
      const gesture = new GhosttySelectionGesture(terminal)
      try {
        const limit = runtime.memory.allocate(8)
        let configuredLimit: number | undefined
        let limitResult: number
        try {
          if (retainedRows === 50001) {
            const result = runtime.exports.ghostty_terminal_set(
              terminal.handle,
              TerminalOption.ScrollbackMaxBytes,
              0,
            )
            if (result !== GhosttyResult.Success) throw new Error('Removing byte limit failed')
          }
          limitResult = runtime.exports.ghostty_terminal_get(
            terminal.handle,
            TerminalData.ScrollbackMaxBytes,
            limit,
          )
          if (retainedRows === 50001 && limitResult !== GhosttyResult.NoValue)
            throw new Error('Unlimited byte limit missing')
          if (retainedRows === 1025 && limitResult !== GhosttyResult.Success)
            throw new Error('Normal byte limit missing')
          if (limitResult === GhosttyResult.Success)
            configuredLimit = runtime.memory.view.getUint32(limit, true)
        } finally {
          runtime.memory.free(limit, 8)
        }
        const rowText = (index: number) =>
          `${String(index).padStart(8, '0')}:${'abcdefghijklmnopqrstuvwxyz'.repeat(3)}`.slice(0, 80)
        terminal.write(
          Array.from({ length: retainedRows }, (_, index) => rowText(index)).join('\r\n'),
        )
        if (terminal.lineCount() !== retainedRows)
          throw new Error(`Retained ${terminal.lineCount()} rows; expected ${retainedRows}`)
        const observedLimit = runtime.memory.allocate(8)
        try {
          const observedResult = runtime.exports.ghostty_terminal_get(
            terminal.handle,
            TerminalData.ScrollbackMaxBytes,
            observedLimit,
          )
          if (observedResult !== limitResult)
            throw new Error('Byte limit result changed after writes')
          if (
            observedResult === GhosttyResult.Success &&
            runtime.memory.view.getUint32(observedLimit, true) !== configuredLimit
          )
            throw new Error('Configured byte limit changed after writes')
        } finally {
          runtime.memory.free(observedLimit, 8)
        }
        gesture.selectAll()
        gesture.getSelection()
        terminal.getSelection()
        terminal.readLines(0, Infinity)
        const samples = []
        let rows = terminal.readLines(0, Infinity)
        for (let run = 0; run < 3; run += 1) {
          const publicStart = performance.now()
          const publicText = gesture.getSelection()
          const publicMs = performance.now() - publicStart
          const nativeStart = performance.now()
          const nativeText = terminal.getSelection()
          const nativeMs = performance.now() - nativeStart
          if (publicText !== nativeText) throw new Error('Selection differs from native formatter')
          if (nativeText?.length !== retainedRows * 81 - 1)
            throw new Error('Selection text is incomplete')
          const historyStart = performance.now()
          rows = terminal.readLines(0, Infinity)
          const readLinesMs = performance.now() - historyStart
          if (
            rows.length !== 1024 ||
            rows.some((row, index) => row.text !== rowText(index) || row.wrapped)
          ) {
            throw new Error('History cap or rows differ from fixture')
          }
          samples.push({ run: run + 1, publicMs, nativeMs, readLinesMs })
        }
        results.push({
          retainedRows,
          columns: 80,
          visibleRows: 24,
          limitResult,
          configuredLimit,
          samples,
          rows,
        })
      } finally {
        gesture.dispose()
        runtime.dispose()
      }
    }
    return results
  })
  if (process.argv[3]) {
    const baseline = await Bun.file(process.argv[3]).json()
    deepStrictEqual(
      fixtures.map(({ rows }) => rows),
      baseline.fixtures.map(({ rows }: { rows: unknown }) => rows),
    )
  }
  const result = {
    browser: browser.version(),
    method: 'CPU text copy; three warmed public-then-native paired runs; history capped at 1024',
    fixtures,
  }
  await Bun.write(output, JSON.stringify(result, null, 2))
  console.log(
    JSON.stringify(
      fixtures.map(({ rows: _rows, ...fixture }) => fixture),
      null,
      2,
    ),
  )
} finally {
  await browser.close()
  server.stop(true)
}

import { GhosttyRuntime } from '../src/core/runtime.ts'
import { writeFile } from 'node:fs/promises'
const rows = []
for (const limit of [0, 10000, 50000]) {
  const runtime = await GhosttyRuntime.create({
    wasm: new URL('../ghostty-vt.wasm', import.meta.url),
    bridge: new URL('../bridge.wasm', import.meta.url),
  })
  const terminal = runtime.createTerminal({ columns: 80, rows: 24 })
  terminal.setScrollbackByteLimit(undefined)
  terminal.setScrollbackLimit(limit)
  const before = runtime.exports.memory.buffer.byteLength
  const line = '0123456789 '.repeat(7) + '\r\n'
  for (let offset = 0; offset < Math.max(limit, 1); offset += 64)
    terminal.write(line.repeat(Math.min(64, Math.max(limit, 1) - offset)))
  Bun.gc(true)
  rows.push({
    limit,
    actualLineBudget: terminal.scrollbackLimit,
    actualByteBudget: terminal.scrollbackByteLimit ?? null,
    inputRows: Math.max(limit, 1),
    retainedRows: terminal.scrollbackLength,
    beforeWasmBytes: before,
    afterWasmBytes: runtime.exports.memory.buffer.byteLength,
    pages: runtime.exports.memory.buffer.byteLength / 65536,
    processMemory: process.memoryUsage(),
    purpose: 'memory capacity only, browser-independent core, no renderer or timing claim',
  })
  runtime.dispose()
}
await writeFile(
  '/work/tmp/ghw-study-20261027/bench/L7a/core-history-memory-unbounded-bytes.json',
  JSON.stringify(rows, null, 2),
)

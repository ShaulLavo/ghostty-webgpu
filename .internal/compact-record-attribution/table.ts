import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { analyze } from './analyze.ts'

const [input, output] = process.argv.slice(2)
assert(input && output)
const result = analyze(JSON.parse(await readFile(input, 'utf8')))
function number(value: unknown): number {
  assert(typeof value === 'number' && Number.isFinite(value))
  return value
}
function distribution(values: number[]) {
  assert.equal(values.length, 2)
  const [first, second] = values
  assert(first !== undefined && second !== undefined)
  return { mean: (first + second) / 2, min: Math.min(first, second), max: Math.max(first, second) }
}
function total(values: Record<string, unknown>) {
  return Object.values(values)
    .map(number)
    .reduce((sum, value) => sum + value, 0)
}
const grouped = new Map<string, typeof result.comparisons>()
for (const entry of result.comparisons) {
  const key = `${entry.backend}/${entry.scenario}`
  grouped.set(key, (grouped.get(key) ?? []).concat([entry]))
}
const table = Array.from(grouped, ([key, entries]) => ({
  key,
  constructionMs: distribution(entries.map((entry) => entry.component.constructionMs)),
  snapshotsMs: distribution(entries.map((entry) => number(entry.component.correctedMs[2]))),
  comparisonMs: distribution(entries.map((entry) => number(entry.component.correctedMs[3]))),
  lookupMs: distribution(entries.map((entry) => number(entry.component.lookupMs))),
  recordsMs: distribution(entries.map((entry) => entry.component.recordsMs)),
  constructionDoseMs: distribution(
    entries.map((entry) => (entry.positive.constructionMs - entry.component.constructionMs) / 31),
  ),
  releasedBridgeMs: distribution(entries.map((entry) => number(entry.bridgeMs.released))),
  extractedBridgeMs:
    entries[0]?.bridgeMs.extracted === null
      ? null
      : distribution(entries.map((entry) => number(entry.bridgeMs.extracted))),
  timedBridgeMs: distribution(entries.map((entry) => number(entry.bridgeMs.timed))),
  positiveConstructionMs: distribution(entries.map((entry) => entry.positive.constructionMs)),
  releasedRendererCpuMs:
    result.delivery === 'prepared-u8'
      ? distribution(entries.map((entry) => number(entry.cpu.released.renderer) * 1000))
      : null,
  releasedGpuCpuMs:
    result.delivery === 'prepared-u8'
      ? distribution(entries.map((entry) => number(entry.cpu.released.GPU) * 1000))
      : null,
  releasedBrowserFamilyCpuMs:
    result.delivery === 'prepared-u8'
      ? distribution(entries.map((entry) => total(entry.cpu.released) * 1000))
      : null,
  deliveredBytes: entries[0]?.bytes,
  uploadedBytes: entries[0]?.uploadedBytes,
}))
await writeFile(output, JSON.stringify({ delivery: result.delivery, table }, null, 2) + '\n')
for (const row of table)
  console.log(
    `| ${row.key.replace('/', ' | ')} | ${row.constructionMs.mean.toFixed(2)} | ${row.snapshotsMs.mean.toFixed(2)} | ${row.comparisonMs.mean.toFixed(2)} | ${row.lookupMs.mean.toFixed(2)} | ${row.releasedBridgeMs.mean.toFixed(2)} | ${row.timedBridgeMs.mean.toFixed(2)} |`,
  )

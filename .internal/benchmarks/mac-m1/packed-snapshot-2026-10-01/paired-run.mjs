import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const count = Number(process.argv[2])
const phase = process.argv[3]
assert([1, 17].includes(count))
assert(['ascii', 'sgr'].includes(phase))
const started = Date.now()
const windows = []
for (let repetition = 0; repetition < 3; repetition++) {
  const order = repetition % 2 ? ['after', 'before'] : ['before', 'after']
  for (const kind of order) {
    let completed = false
    for (let attempt = 0; attempt < 3; attempt++) {
      // NOT-PORTABLE: Requires macOS pmset and separately prepared archived runner copies.
      const power = execFileSync('/usr/bin/pmset', ['-g', 'batt'], { encoding: 'utf8' })
      assert(power.includes("'AC Power'"), 'AC power required')
      const remaining = 29 * 60_000 - (Date.now() - started)
      assert(remaining > 0, 'Paired window expired')
      const directory = `${kind}-${count}-${phase}-${repetition}-${attempt}`
      console.log(
        JSON.stringify({
          count,
          phase,
          repetition,
          kind,
          attempt,
          power,
          started: new Date().toISOString(),
        }),
      )
      const result = spawnSync(
        process.execPath,
        [
          join(root, kind, 'comparison-runner.mjs'),
          '--trace',
          '--trace-count',
          String(count),
          '--trace-phase',
          phase,
          '--display-awake',
          '--only-repetition',
          String(repetition),
          '--output',
          join(root, directory),
        ],
        { stdio: 'inherit', timeout: remaining },
      )
      const powerAfter = execFileSync('/usr/bin/pmset', ['-g', 'batt'], { encoding: 'utf8' })
      assert(powerAfter.includes("'AC Power'"), 'AC power required throughout window')
      if (result.status === 0) {
        windows.push({ kind, count, phase, repetition, attempt, directory, power, powerAfter })
        writeFileSync(
          join(root, `${count}-${phase}-windows.json`),
          JSON.stringify(windows, null, 2) + '\n',
        )
        completed = true
        break
      }
      const artifact = JSON.parse(readFileSync(join(root, directory, 'comparison.json'), 'utf8'))
      assert.equal(
        artifact.invalid,
        'Mac display unavailable',
        `${directory} failed: ${result.error ?? result.signal ?? artifact.error ?? ''}`,
      )
      console.log(JSON.stringify({ rejected: directory, reason: artifact.invalid }))
    }
    assert(completed, `${kind}/${count}/${phase}/${repetition} exhausted display retries`)
  }
}
console.log(
  JSON.stringify({
    count,
    phase,
    completedWindows: windows.length,
    elapsedMinutes: (Date.now() - started) / 60_000,
  }),
)

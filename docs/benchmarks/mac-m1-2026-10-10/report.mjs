import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'

const root = new URL('./', import.meta.url)
const data = JSON.parse(await readFile(new URL('scores.json', root)))
const base = 'https://github.com/ShaulLavo/fregat/blob/main/ghostty-webgpu/'
const evidence = `${base}docs/benchmarks/mac-m1-2026-10-10/`
const { versions, runtimeCommit } = data.conditions
const labels = {
  'rolling-logs': 'Heavy log output',
  'rolling-unicode-logs': 'Heavy Unicode output',
  'unicode-emoji': 'One Unicode line per tick',
  'line-scroll': 'One ASCII line per tick',
  'interactive-edits': 'Typing-like edits',
}
const history = (row) => {
  if (row.history === 'bounded-matched-final')
    return `${row.historyRows.toLocaleString('en-US')} final rows`
  return `${row.historyRows} rows`
}
const direction = (pairs) => {
  if (pairs.every((value) => value < 1)) return 'lower'
  if (pairs.every((value) => value >= 1)) return 'higher'
  return 'mixed'
}
const pairOutcome = (row) => {
  const energy = direction(row.energyPairs)
  const instructions = direction(row.instructionPairs)
  if (energy === 'mixed' && instructions === 'mixed') return 'Mixed across the two pairs'
  if (energy === instructions) return `${energy[0].toUpperCase()}${energy.slice(1)} in both pairs`
  const scope = energy === 'mixed' || instructions === 'mixed' ? '' : ', in both pairs'
  return `Energy ${energy}, instructions ${instructions}${scope}`
}
const number = (value) => value.toFixed(3)
const less = (ratio, digits = 0) => ((1 - ratio) * 100).toFixed(digits)
const more = (ratio, digits = 0) => ((ratio - 1) * 100).toFixed(digits)
const pick = (rows, workload) => rows.find((row) => row.workload === workload)
const compact = (rows) =>
  ['| Workload | CPU energy ratio | Instruction ratio |', '| --- | ---: | ---: |']
    .concat(
      rows.map(
        (row) =>
          `| ${labels[row.workload]} | ${number(row.energy)} | ${number(row.instructions)} |`,
      ),
    )
    .join('\n')
const table = (rows) =>
  [
    '| Workload | History | CPU energy ratio | Instruction ratio | CPU seconds ratio | Pairs | Evidence |',
    '| --- | --- | ---: | ---: | ---: | --- | --- |',
  ]
    .concat(
      rows.map(
        (row) =>
          `| ${labels[row.workload]} | ${history(row)} | ${number(row.energy)} | ${number(row.instructions)} | ${number(row.cpuSeconds)} | ${pairOutcome(row)} | [Counters](${evidence}${row.source}) · [Review](${evidence}${row.review}) |`,
      ),
    )
    .join('\n')
const gl = data.scores.filter((row) => row.renderer === 'ghostty WebGL')
const dom = data.scores.filter((row) => row.renderer === 'ghostty DOM')
const lessBoth = (rows, workload) =>
  `${less(pick(rows, workload).energy)}% and ${less(pick(rows, workload).instructions)}%`
const glLine = pick(gl, 'unicode-emoji')
const domEdits = pick(dom, 'interactive-edits')
const unavailable = data.unavailable
  .map((gap) => `${labels[gap.workload]} is unavailable for DOM: ${gap.reason}`)
  .join(' ')
const report = `# Terminal comparison benchmarks

These are instrumented whole-terminal measurements of ghostty-webgpu ${versions['ghostty-webgpu']} (Fregat commit \`${runtimeCommit}\`). They measure CPU work and estimated CPU energy while terminals receive paced output, and they show workload-specific results from one Mac on the evening of 2026-10-09 UTC. Later builds are not measured here.

Every ratio is ghostty divided by xterm.js. Below 1 means ghostty uses less. Energy and instructions are the efficiency metrics. CPU seconds appear for context. Apple Silicon changes its clock speed with load, so a run that does less work can take more CPU seconds.

[Scores](${evidence}scores.json) · [Method and recompute](${evidence}README.md) · [Offline verifier](${evidence}verify.mjs)

## WebGL vs xterm.js WebGL

Apple M1 MacBook, AC power, headed Chrome 154.0.8037.93, hardware ANGLE Metal GPU. Acquired 2026-10-09 UTC, reviewed 2026-10-10. ghostty-webgpu ${versions['ghostty-webgpu']}; xterm.js ${versions['@xterm/xterm']} with WebGL addon ${versions['@xterm/addon-webgl']}, plus its Unicode 11 addon ${versions['@xterm/addon-unicode11']} on one Unicode line per tick. 40 × 12 cells, DPR 2, a 560 × 456-pixel drawing buffer for both libraries, 17 visible terminals. Each workload has 120 warm-up ticks and 900 measured ticks paced at 60 Hz. Each row is the median of two balanced pair ratios from one browser session, and every workload ran in its own session. Counters cover the endpoint-enumerated Chrome process family, including GPU-process CPU work.

${table(gl)}

WebGL uses ${less(pick(gl, 'rolling-logs').energy)}% less estimated CPU energy and ${less(pick(gl, 'rolling-logs').instructions)}% fewer instructions on heavy log output. The same two figures are ${lessBoth(gl, 'rolling-unicode-logs')} on heavy Unicode output, ${lessBoth(gl, 'line-scroll')} on one ASCII line per tick and ${lessBoth(gl, 'interactive-edits')} on typing-like edits. One ASCII line per tick is the \`line-scroll\` workload: each tick appends one line, so the screen scrolls one row per tick. Its margins and the edits margins are small and come from two pairs per cell.

One Unicode line per tick is even. Energy is ${less(glLine.energy, 1)}% lower in both pairs and instructions are ${more(glLine.instructions, 1)}% higher in both pairs.

The bounded log workloads finish with matching retained text and equal history: ${pick(gl, 'rolling-logs').historyRows.toLocaleString('en-US')} rows per terminal for heavy log output and ${pick(gl, 'rolling-unicode-logs').historyRows.toLocaleString('en-US')} for heavy Unicode output. The check compares final retained output. It does not prove equal intermediate retention or identical rasters.

## DOM vs xterm.js DOM

Same machine, browser, build and dates. ghostty-webgpu ${versions['ghostty-webgpu']} DOM against xterm.js ${versions['@xterm/xterm']} DOM. Both use a normalized 360 × 288 CSS-pixel surface, a 15px font and hidden scrollbars. 40 × 12 cells, DPR 2, 17 visible terminals, 120 warm-up ticks and 900 measured ticks at 60 Hz. Ratios are medians of two balanced pairs of all-Chrome counter deltas.

${table(dom)}

DOM uses ${less(pick(dom, 'rolling-logs').energy)}% less estimated CPU energy and ${less(pick(dom, 'rolling-logs').instructions)}% fewer instructions on heavy log output. The same two figures are ${lessBoth(dom, 'rolling-unicode-logs')} on heavy Unicode output and ${lessBoth(dom, 'line-scroll')} on one ASCII line per tick. Typing-like edits are even: median energy is ${more(domEdits.energy, 1)}% higher, median instructions are ${less(domEdits.instructions, 1)}% lower, and the two pairs disagree on both energy and instructions.

${unavailable}

## Not published here

This page publishes the WebGL and DOM tables only. Canvas, WebGPU, Linux and Raspberry Pi 4 results are not published. xterm.js has no WebGPU renderer, so a WebGPU row would be a cross-API comparison.

## Memory

A fair memory comparison covers the whole browser process family, including resident WebAssembly memory. Report the idle baseline, retained-history phase and their delta, along with actual retained rows. GPU-device allocations need a separate measurement and label. Avoid adding WASM capacity to RSS, which already includes resident WASM pages.

This page makes no numeric memory claim.

## Method limits

Energy is the macOS kernel's per-process CPU energy estimate from \`proc_pid_rusage\` with \`RUSAGE_INFO_V6\`. It includes GPU-process CPU work, and excludes GPU-device, display, non-Chrome and whole-system power. Instructions are retired CPU instructions across the same process family. Cycles, CPU seconds, core placement and effective clocks are diagnostics. The M1 runs light work on its efficiency cores, so a terminal that does less work can show more cycles.

Each cell has two chronological ghostty and xterm.js pairs, ordered ABBA or BAAB. A browser session shares windows between renderers, so the two windows of a pair need not be adjacent. Two pairs give descriptive observations. They carry no significance test. The benchmark observer is enabled and its overhead is not calibrated, so none is subtracted.

Native snapshots bracket the reset, paced writes, logical settlement through two animation frames, and target-counter snapshots. Text and screenshots are captured afterwards. This endpoint proves logical settlement; it does not prove physical presentation. Stable PID, type and start identities at the endpoints cannot capture a process born and gone entirely between samples. Samples are sequential and non-atomic.

These tables do not support a claim that ghostty is faster on every workload. Each saved record preserves per-process counter deltas, output digests and work counts. Recompute every ratio with \`node docs/benchmarks/mac-m1-2026-10-10/verify.mjs\`, from \`ghostty-webgpu/\`.
`
const readmeUrl = new URL('../../../README.md', root)
const oldReadme = await readFile(readmeUrl, 'utf8')
const sectionStart = oldReadme.indexOf('## Performance\n')
const sectionEnd = oldReadme.indexOf('\n### Correctness\n', sectionStart)
assert(sectionStart >= 0 && sectionEnd > sectionStart, 'README benchmark section is missing')
const section = oldReadme.slice(sectionStart, sectionEnd)
const readmeTable = /^\| Workload\s*\| CPU energy ratio[^\n]*\n(?:\|[^\n]*\n)+/m
assert(readmeTable.test(section), 'README WebGL table is missing')
const nextReadme =
  oldReadme.slice(0, sectionStart) +
  section.replace(readmeTable, `${compact(gl)}\n`) +
  oldReadme.slice(sectionEnd)
const normalize = (text) =>
  text
    .split('\n')
    .map((line) => {
      if (!line.startsWith('|')) return line
      return line
        .split('|')
        .map((cell) => {
          const trimmed = cell.trim()
          if (/^:?-+:?$/.test(trimmed)) return trimmed.replace(/-+/g, '-')
          return trimmed
        })
        .join('|')
    })
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
const targets = [
  [new URL('../../benchmarks.md', root), report],
  [readmeUrl, nextReadme],
]
for (const [url, text] of targets) {
  if (process.argv.includes('--check'))
    assert.equal(
      normalize(await readFile(url, 'utf8')),
      normalize(text),
      `${url.pathname} differs from reviewed data`,
    )
  else await writeFile(url, text)
}
console.log(
  process.argv.includes('--check')
    ? 'PASS: public report and README match reviewed data'
    : 'Updated public report and README from reviewed data',
)

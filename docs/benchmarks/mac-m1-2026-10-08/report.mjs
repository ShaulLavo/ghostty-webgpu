import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'

const root = new URL('./', import.meta.url)
const data = JSON.parse(await readFile(new URL('scores.json', root)))
const base = 'https://github.com/ShaulLavo/ghostty-webgpu/blob/main/'
const evidence = `${base}docs/benchmarks/mac-m1-2026-10-08/`
const labels = {
  'rolling-logs': 'Heavy log output',
  'rolling-unicode-logs': 'Heavy Unicode output',
  'unicode-emoji': 'One Unicode line per tick',
  'line-scroll': 'One ASCII line per tick',
  'interactive-edits': 'Typing-like edits',
}
const history = (row) => {
  if (row.history === 'equal ~9k') return '8,841 final rows'
  if (row.history === 'full-stream') return 'Full stream'
  if (row.workload === 'interactive-edits') return '0 rows'
  return '889 rows'
}
const number = (value) => value.toFixed(3)
const compact = (rows) =>
  [
    '| WebGL vs xterm.js WebGL | CPU energy ratio | Instruction ratio |',
    '| --- | ---: | ---: |',
    ...rows.map(
      (row) => `| ${labels[row.workload]} | ${number(row.energy)} | ${number(row.instructions)} |`,
    ),
  ].join('\n')
const table = (rows) =>
  [
    '| Workload | History | CPU energy ratio | Instruction ratio | CPU seconds ratio | Evidence |',
    '| --- | --- | ---: | ---: | ---: | --- |',
    ...rows.map(
      (row) =>
        `| ${labels[row.workload]} | ${history(row)} | ${number(row.energy)} | ${number(row.instructions)} | ${number(row.cpuSeconds)} | [Counters](${evidence}${row.source}) · [Review](${evidence}${row.review}) |`,
    ),
  ].join('\n')
const gl = data.scores.filter((row) => row.renderer === 'ghostty WebGL')
const dom = data.scores.filter((row) => row.renderer === 'ghostty DOM')
const report = `# Terminal comparison benchmarks

Reviewed round-1 results, published 2026-10-08. These are instrumented whole-terminal measurements of a frozen build. They measure CPU work and estimated CPU energy while terminals receive paced output. They establish workload-specific wins and losses on one Mac session.

Every ratio is ghostty divided by xterm.js. Below 1 means ghostty uses less. Energy and instructions are the efficiency metrics. CPU seconds appear for context. Apple Silicon clock changes can make a lower-work run take more CPU seconds, so pre-2026-10-07 CPU-seconds verdicts are superseded. See [the counter investigation](https://github.com/ShaulLavo/fregat/issues/925).

[Reviewed data](${evidence}scores.json) · [Method and reproduction](${evidence}README.md) · [Offline verifier](${evidence}verify.mjs)

## WebGL vs xterm.js WebGL

Apple M1 MacBook, AC power, headed Chrome 154.0.8037.93, hardware ANGLE Metal GPU. Acquired 2026-10-07 UTC, reviewed 2026-10-08. ghostty-webgpu 0.3.20 at commit \`902687697db8a58a211495d07f4938d331feef92\`; xterm.js 6.0.0 with WebGL addon 0.19.0. JetBrains Mono 5.3.0, 12px font, 40 × 12 cells, DPR 2, 17 visible terminals. Each workload has 120 warm-up ticks and 900 measured ticks paced at 60 Hz. The table reports the median of four balanced adjacent-pair ratios in one browser session. Counters cover the endpoint-enumerated Chrome process family, including GPU-process CPU work.

${table(gl)}

The bounded log workloads finish with matching retained text and 8,841 history rows. Ghostty uses its page-granular 10,000-row limit and 64 MiB byte budget; xterm.js uses an exact 8,841-row cap. Intermediate retained history differs. The Unicode run has no Mac history trajectory, so equal final rows do not prove equal retention throughout the stream. Reviews qualify these observations with limits, including the observer calibration's two-pair scope.

The losses matter. WebGL uses about 32% more estimated CPU energy on one Unicode line per tick, and 36% more on one ASCII line per tick. Typing-like edits are near parity in energy but use about 5% more instructions.

## DOM vs xterm.js DOM

Apple M1 MacBook, AC power, headed Chrome 154.0.8037.93, hardware ANGLE Metal GPU. Acquired 2026-10-07 UTC, reviewed 2026-10-08. ghostty-webgpu 0.3.20 at the same frozen commit; xterm.js 6.0.0 DOM. JetBrains Mono 5.3.0, 40 × 12 cells, DPR 2, 17 visible terminals, 120 warm-up ticks and 900 measured ticks at 60 Hz. Rolling logs use four balanced pairs; other rows use two. Ratios are medians of paired all-Chrome counter deltas.

${table(dom)}

Rolling logs retain the full stream with a 200,000-row cap and a 64 MiB native byte budget. This is a heavy-history condition, distinct from the bounded WebGL logs. Rolling and Unicode use default surfaces, with slightly different widths and scrollbar rasters. Unicode also differs in emoji composition. These rows qualify text-equivalent whole-terminal observations, with about a 3% width difference on rolling logs. They do not qualify equal-raster or isolated-renderer claims.

ASCII line scrolling and edits use normalized 360 × 288 CSS-pixel grids, a 15px font, and hidden scrollbar rasters. The two-pair reviews still flag uncalibrated observer overhead and endpoint-only process coverage. DOM loses on typing-like edits, using about 15% more energy and instructions. No DOM heavy-Unicode-output result is published yet.

## Canvas vs Canvas

A reviewed current-build Canvas comparison is pending. The round-1 Canvas observations used an older frozen build and have no independent headline review, so their numbers are omitted here. The next pair is ghostty Canvas vs xterm.js 5.5.0 with Canvas addon 0.7.0. xterm.js 6 removed Canvas. A separate Canvas pair can compare ghostty-web 0.4.0, with its combining-mark and emoji-joiner output differences stated.

## WebGPU

xterm.js has no WebGPU renderer. A WebGPU-vs-xterm.js-WebGL table would be cross-API. Round-1 cross-API observations predate the shipped glyph-upload change and have no independent review for this public table, so their numbers are omitted. WebGPU own-control experiments and cross-API results need their own labeled, reviewed evidence.

## Memory

A fair memory comparison covers the whole browser process family, including resident WebAssembly memory. Report the idle baseline, retained-history phase and their delta, along with actual retained rows. GPU-device allocations need a separate measurement and label. Avoid adding WASM capacity to RSS, which already includes resident WASM pages.

The October 1 report's \`memory/10k\` counted JS and backing storage while reporting WASM capacity separately. Its small ghostty figure excluded history stored in WASM. That table cannot support a whole-browser memory headline. Its RSS deltas also include negative samples, so this page makes no numeric memory claim. Whole-browser memory for matched WebGL, DOM and Canvas conditions needs a fresh session.

## Method limits

Energy is the macOS kernel's per-process CPU energy estimate from \`proc_pid_rusage\` with \`RUSAGE_INFO_V6\`. It includes GPU-process CPU work, and excludes GPU-device, display, non-Chrome and whole-system power. Instructions are retired CPU instructions across the same process family.

Native snapshots bracket the reset, paced writes, logical settlement through two animation frames, and target-counter snapshots. Text and screenshots are captured afterwards. This endpoint proves logical settlement; it does not prove physical presentation. Stable PID/type/start identities at the endpoints cannot capture a process born and gone entirely between samples. Samples are sequential and non-atomic. Reviews retain these limits and the workload-specific observer limitations.

All public rows have an independent review. Each saved record preserves per-process counter deltas, output digests, work counts, geometry and original artifact hashes. Private acquisition paths were removed. The verifier recomputes the ratios, and the reproduction package carries the frozen runtime assets and the measurement scripts. There are no new hardware measurements in this publication.

## Fresh Mac session needed

The terminal performance wave owns the next Mac session. This publication starts no Mac jobs.

- Current-main, same-session WebGL and DOM comparisons on all five workloads, including DOM heavy Unicode output. Use equal bounded history and record its trajectory.
- Canvas vs Canvas with independent review, matching work and retained history.
- Current WebGPU own-control results and explicitly cross-API comparisons, with independent review.
- Parser throughput on current main. The October 1 parser numbers are historical and have been removed from the README headline.
- Whole-browser memory including resident WASM, matched retained rows, idle/history baselines and repeatability checks.
- Write-to-presentation and key-to-presentation latency with at least 100 samples per case, at 1 and 17 terminals. Plan 283 retired the old CDP-screencast latency rows because their capture cadence distorted the endpoint.

Raspberry Pi capacity observations used unequal pages and history settings. They are omitted from the comparative tables.
`
const readmeUrl = new URL('../../../README.md', root)
const oldReadme = await readFile(readmeUrl, 'utf8')
const sectionStart = oldReadme.indexOf('## Measured wins and losses\n')
const sectionEnd = oldReadme.indexOf('\n### Correctness\n', sectionStart)
assert(sectionStart >= 0 && sectionEnd > sectionStart, 'README benchmark section is missing')
const section = oldReadme.slice(sectionStart, sectionEnd)
const readmeTable = /^\| WebGL vs xterm\.js WebGL[^\n]*\n(?:\|[^\n]*\n)+/m
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

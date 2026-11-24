// Renders the November 2026 section of docs/benchmarks.md from docs/benchmarks/2026-11-24/results.json.
// docs/benchmarks/mac-m1-2026-10-10/report.mjs calls it; Node runs this file with type stripping.
import { readFile } from 'node:fs/promises'

type Status = 'unsupported' | 'text-mismatch' | 'crash'
type Value = number | Status
type Host = 'pc' | 'mac'
interface Row {
  workload: string
  terminals: number
  values: Record<string, Value>
}
interface SizeRow {
  app: string
  backend: string
  raw: number
  gzip: number
  brotli: number
  font: { file: string; kib: number } | null
  brotliWithFont: number
}
interface LoadRow {
  app: string
  backend: string
  median: number
  p95: number
}
interface Data {
  measured: string
  commit: string
  coldLoadCommit?: string
  version: string
  libraries: Record<string, string>
  drift: Record<Host, number>
  hosts: Record<Host, { machine: string; browser: string; dpr: number }>
  speed: Record<
    Host,
    Record<'cpu' | 'ackP95' | 'forcedP95' | 'energy', Row[] | undefined> & { runs: number }
  >
  size: SizeRow[]
  coldLoad: Record<Host, Record<'unthrottled' | 'fast4g', LoadRow[]>>
}
interface Pick {
  arm: string
  value: number
}

const folder = 'docs/benchmarks/2026-11-24/'
const evidence = `https://github.com/ShaulLavo/ghostty-webgpu/blob/main/${folder}`
// Repetition-to-repetition CPU spread was 4% median and 8% at p75, so a loss needs more than 10%
// over the competitor and a win more than 10% under it. Ratios use unrounded values.
const MARGIN = 1.1
const WIN = 0.9
// Latencies sit on the browser's 0.1 ms timer grid; a latency loss also needs 0.5 ms.
const LATENCY_FLOOR = 0.5

const OURS: Record<string, string> = {
  'ours-main-webgpu': 'main WebGPU',
  'ours-main-webgl2': 'main WebGL2',
  'ours-main-canvas2d': 'main Canvas2D',
  'ours-main-dom': 'main DOM',
  'ours-worker-webgpu': 'worker WebGPU',
  'ours-worker-webgl2': 'worker WebGL2',
  'ours-pool-webgpu': 'pool WebGPU',
  'ours-pool-webgl2': 'pool WebGL2',
}
const LIBRARIES: { name: string; arms: Record<string, string> }[] = [
  { name: 'xterm.js', arms: { 'xterm-webgl': 'WebGL', 'xterm-dom': 'DOM' } },
  { name: 'ghostty-web', arms: { 'ghostty-web-canvas2d': 'Canvas2D' } },
  { name: 'Wraith', arms: { 'wraith-webgpu': 'WebGPU' } },
  { name: 'Restty', arms: { 'restty-webgpu': 'WebGPU', 'restty-webgl2': 'WebGL2' } },
]
const COMPETITORS: Record<string, string> = Object.assign(
  {},
  ...LIBRARIES.map((library) =>
    Object.fromEntries(
      Object.entries(library.arms).map(([arm, backend]) => [arm, `${library.name} ${backend}`]),
    ),
  ),
)
const ARM_LABEL: Record<string, string> = Object.assign(
  Object.fromEntries(Object.entries(OURS).map(([arm, label]) => [arm, `ours ${label}`])),
  COMPETITORS,
)
const WORKLOADS: Record<string, string> = {
  'rolling-logs': 'real log output in 4 KiB writes, 256 KiB per terminal over the 64 steps',
  'rolling-unicode-logs': 'the same kind of logs with CJK, combining marks and emoji, also 256 KiB',
  'rolling-slow': 'one log line per write',
  'unicode-emoji': 'one Unicode and emoji line per write',
  'line-scroll': 'one ASCII line per write, scrolling one row each time',
  'interactive-edits': 'one row rewritten per write, like typing',
  'ntcharts-heatmap': 'full-screen true-colour heatmap frames captured from NTCharts',
  'opentui-plasma': 'full-screen half-block plasma frames from OpenTUI, a colour at every cell',
  'synchronized-frames': 'dense frames inside synchronized-output brackets (DEC mode 2026)',
  'partial-scroll': 'scrolling inside a scroll region',
  'insert-delete-lines': 'insert-line and delete-line sequences',
  'sparse-edits': 'single-cell colour edits spread over the screen',
  'ligature-redraw': 'full redraws of operator-heavy code text (ligatures off everywhere)',
  'glyph-churn': 'a stream of never-seen CJK glyphs and emoji that keeps growing the glyph atlas',
  'cold-cache': 'Unicode text with the glyph atlas cleared before every write',
  'repeated-ascii': 'the same full ASCII screen written again every step',
  'write-queue-overload': 'the whole rolling-logs corpus (about 1 MiB) queued at once, unpaced',
}
const STATUS: Record<Status, string> = {
  unsupported: 'n/a',
  'text-mismatch': 'text differs',
  crash: 'crashed',
}

const cell = (value: Value | undefined, digits: number) => {
  if (value === undefined) return ''
  return typeof value === 'number' ? value.toFixed(digits) : STATUS[value]
}
// The first `text` columns are left-aligned; the rest hold numbers.
const table = (header: string[], rows: string[][], text = 1) =>
  [
    `| ${header.join(' | ')} |`,
    `| ${header.map((_, index) => (index < text ? '---' : '---:')).join(' | ')} |`,
  ]
    .concat(rows.map((row) => `| ${row.join(' | ')} |`))
    .join('\n')
const SHORT: Record<string, string> = {
  'xterm.js 6 + WebGL addon': 'xterm.js',
  'xterm.js 6 + WebGL + Unicode 11 addons': 'xterm.js with Unicode 11',
  'ghostty-web 0.4.0 (Canvas 2D)': 'ghostty-web',
  'Wraith 0.6.1 native (worker, WebGPU)': 'Wraith',
  'Wraith 0.6.1 xterm profile': "Wraith's xterm profile",
  'Restty 0.3.0 (WebGPU, WebGL2 fallback)': 'Restty',
}
const shortName = (app: string) => SHORT[app] ?? app.replace(/^ghostty-webgpu /, '')
const terminals = (count: number) => (count === 1 ? '1 terminal' : `${count} terminals`)

function best(values: Record<string, Value>, arms: readonly string[]): Pick | undefined {
  let found: Pick | undefined
  for (const arm of arms) {
    const value = values[arm]
    if (typeof value !== 'number') continue
    if (!found || value < found.value) found = { arm, value }
  }
  return found
}

function libraryCell(values: Record<string, Value>, arms: Record<string, string>, digits: number) {
  const ids = Object.keys(arms)
  const pick = best(values, ids)
  if (!pick) return cell(values[ids[0]!], digits)
  if (ids.length === 1) return pick.value.toFixed(digits)
  return `${pick.value.toFixed(digits)} (${arms[pick.arm]})`
}

interface Comparison {
  row: Row
  ours: Pick
  theirs: Pick
  ratio: number
}

function compare(rows: readonly Row[]): Comparison[] {
  const comparisons: Comparison[] = []
  for (const row of rows) {
    const ours = best(row.values, Object.keys(OURS))
    const theirs = best(row.values, Object.keys(COMPETITORS))
    if (!ours || !theirs) continue
    comparisons.push({ row, ours, theirs, ratio: ours.value / theirs.value })
  }
  return comparisons
}

const loses = (comparison: Comparison, latency: boolean) =>
  comparison.ratio > MARGIN &&
  (!latency || comparison.ours.value - comparison.theirs.value > LATENCY_FLOOR)

function comparisonTable(rows: readonly Row[], digits: number) {
  const byKey = new Map(compare(rows).map((entry) => [entry.row, entry]))
  const body = rows.map((row) => {
    const entry = byKey.get(row)
    const ours = entry ? `${entry.ours.value.toFixed(digits)} (${OURS[entry.ours.arm]})` : ''
    const ratio = entry ? entry.ratio.toFixed(2) : ''
    return [row.workload, String(row.terminals), ours]
      .concat(LIBRARIES.map((library) => libraryCell(row.values, library.arms, digits)))
      .concat([entry && loses(entry, false) ? `**${ratio}**` : ratio])
  })
  return table(
    ['Workload', 'Terminals', 'ghostty-webgpu (best backend)']
      .concat(LIBRARIES.map((library) => library.name))
      .concat(['Ours ÷ best other']),
    body,
  )
}

function fullTable(rows: readonly Row[], digits: number) {
  const arms = Object.keys(ARM_LABEL).filter((arm) => arm in rows[0]!.values)
  return table(
    ['Workload', 'Terminals'].concat(arms.map((arm) => ARM_LABEL[arm]!)),
    rows.map((row) =>
      [row.workload, String(row.terminals)].concat(
        arms.map((arm) => cell(row.values[arm], digits)),
      ),
    ),
  )
}

function lossList(comparisons: readonly Comparison[], unit: string, digits: number) {
  return comparisons
    .map(
      (entry) =>
        `- ${entry.row.workload} at ${terminals(entry.row.terminals)}: ${COMPETITORS[entry.theirs.arm]} ${entry.theirs.value.toFixed(digits)} ${unit} against our ${OURS[entry.ours.arm]} ${entry.ours.value.toFixed(digits)} ${unit} (${entry.ratio.toFixed(2)}x)`,
    )
    .join('\n')
}

const rowsOf = (data: Data, host: Host, metric: 'cpu' | 'ackP95' | 'forcedP95' | 'energy') => {
  const rows = data.speed[host][metric]
  if (!rows) throw new Error(`results.json has no ${metric} for ${host}`)
  return rows
}
const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function standing(comparisons: readonly Comparison[], latency: boolean) {
  const lost = comparisons.filter((entry) => loses(entry, latency))
  const ahead = comparisons.filter((entry) => entry.ratio < WIN).length
  return {
    lost,
    ahead,
    even: comparisons.length - lost.length - ahead,
    total: comparisons.length,
    median: median(comparisons.map((entry) => entry.ratio)),
  }
}

const sizeTable = (rows: readonly SizeRow[]) =>
  table(
    ['App', 'Renderer', 'Raw', 'gzip', 'Brotli', 'Font file (wire)', 'Brotli + font'],
    rows.map((row) => [
      row.app,
      row.backend,
      row.raw.toFixed(1),
      row.gzip.toFixed(1),
      row.brotli.toFixed(1),
      row.font ? `${row.font.kib.toFixed(1)}` : '-',
      row.brotliWithFont.toFixed(1),
    ]),
    2,
  )

function loadTable(data: Data) {
  const columns: [Host, 'unthrottled' | 'fast4g'][] = [
    ['pc', 'unthrottled'],
    ['pc', 'fast4g'],
    ['mac', 'unthrottled'],
    ['mac', 'fast4g'],
  ]
  const apps = data.coldLoad.pc.unthrottled.map((row) => row.app)
  const loadCell = (host: Host, profile: 'unthrottled' | 'fast4g', app: string) => {
    const row = data.coldLoad[host][profile].find((candidate) => candidate.app === app)
    if (!row) throw new Error(`no cold-load row for ${app} on ${host} ${profile}`)
    return `${row.median} (${row.p95})`
  }
  return table(
    ['App', 'PC unthrottled', 'PC Fast 4G', 'Mac unthrottled', 'Mac Fast 4G'],
    apps.map((app) => [app].concat(columns.map(([host, profile]) => loadCell(host, profile, app)))),
  )
}

const isOurs = (app: string) => app.startsWith('ghostty-webgpu')
const smallest = (rows: readonly SizeRow[]) =>
  rows.filter((row) => isOurs(row.app)).toSorted((a, b) => a.brotliWithFont - b.brotliWithFont)[0]!

function sizeSummary(rows: readonly SizeRow[]) {
  const ours = smallest(rows)
  const others = rows.filter((row) => !isOurs(row.app))
  const describe = (row: SizeRow) => `${shortName(row.app)} ${row.brotliWithFont.toFixed(1)}`
  const smaller = others.filter((row) => row.brotliWithFont < ours.brotliWithFont).map(describe)
  const larger = others.filter((row) => row.brotliWithFont >= ours.brotliWithFont).map(describe)
  return `Our smallest setup (${shortName(ours.app)}) downloads ${ours.brotliWithFont.toFixed(1)} KiB brotli. Smaller: ${smaller.join(', ')} KiB. Larger: ${larger.join(', ')} KiB.`
}

function loadLeaders(data: Data, host: Host, profile: 'unthrottled' | 'fast4g') {
  const rows = data.coldLoad[host][profile]
  const ours = rows.filter((row) => isOurs(row.app)).toSorted((a, b) => a.median - b.median)[0]!
  const faster = rows
    .filter((row) => !isOurs(row.app) && row.median < ours.median)
    .toSorted((a, b) => a.median - b.median)
    .map((row) => `${shortName(row.app)} ${row.median}`)
  const label = `${host === 'pc' ? 'PC' : 'Mac'} ${profile === 'fast4g' ? 'Fast 4G' : 'unthrottled'}`
  const tail = faster.length ? `; faster: ${faster.join(', ')} ms` : '; no competitor is faster'
  return `${label}: our best ${ours.median} ms${tail}`
}

const PROFILES: [Host, 'unthrottled' | 'fast4g', string][] = [
  ['pc', 'unthrottled', 'PC unthrottled'],
  ['pc', 'fast4g', 'PC Fast 4G'],
  ['mac', 'unthrottled', 'Mac unthrottled'],
  ['mac', 'fast4g', 'Mac Fast 4G'],
]

function coldLoadNotes(data: Data) {
  const fastest = PROFILES.map(([host, profile, label]) => {
    const row = data.coldLoad[host][profile].toSorted((a, b) => a.median - b.median)[0]!
    return `${label} ${shortName(row.app)} (${row.median} ms)`
  })
  return `Fastest first paint: ${fastest.join(', ')}.`
}

export async function renderNovember(): Promise<{ version: string; markdown: string }> {
  const source = new URL(`../${folder}results.json`, import.meta.url)
  const data: Data = JSON.parse(await readFile(source, 'utf8'))
  return { version: data.version, markdown: render(data) }
}

function render(data: Data) {
  const short = data.commit.slice(0, 9)
  const coldLoadShort = data.coldLoadCommit?.slice(0, 9)
  const lib = data.libraries
  const cpu = {
    pc: standing(compare(rowsOf(data, 'pc', 'cpu')), false),
    mac: standing(compare(rowsOf(data, 'mac', 'cpu')), false),
  }
  const energy = standing(compare(rowsOf(data, 'mac', 'energy')), false)
  const ack = {
    pc: standing(compare(rowsOf(data, 'pc', 'ackP95')), true),
    mac: standing(compare(rowsOf(data, 'mac', 'ackP95')), true),
  }
  const forced = {
    pc: standing(compare(rowsOf(data, 'pc', 'forcedP95')), true),
    mac: standing(compare(rowsOf(data, 'mac', 'forcedP95')), true),
  }
  const webgl2Best = (host: Host) =>
    compare(rowsOf(data, host, 'cpu')).filter((entry) => entry.ours.arm === 'ours-main-webgl2')
      .length
  const fullTables = (host: Host, title: string) => `<details>
<summary>${title}: every backend</summary>

${fullTable(rowsOf(data, host, 'cpu'), 3)}

</details>`

  return `## November 2026: against xterm.js, ghostty-web, Wraith and Restty

Measured ${data.measured} on ghostty-webgpu ${data.version} (commit \`${short}\`) against xterm.js ${lib['@xterm/xterm']} (WebGL addon ${lib['@xterm/addon-webgl']}), ghostty-web ${lib['ghostty-web']}, Wraith (\`wraithterm\`) ${lib.wraithterm} and Restty ${lib.restty}, on two machines:

- **PC:** ${data.hosts.pc.machine}; ${data.hosts.pc.browser}; DPR ${data.hosts.pc.dpr}.
- **Mac:** ${data.hosts.mac.machine}; ${data.hosts.mac.browser}; DPR ${data.hosts.mac.dpr}.

[Data](${evidence}results.json) · [Method and how the data was made](${evidence}README.md)

### Summary

- **CPU.** Our best backend uses more than 10% less whole-browser CPU than the best competitor in ${cpu.pc.ahead} of ${cpu.pc.total} PC cells and ${cpu.mac.ahead} of ${cpu.mac.total} Mac cells, is within 10% in ${cpu.pc.even} and ${cpu.mac.even}, and loses by more than 10% in ${cpu.pc.lost.length} and ${cpu.mac.lost.length}. The median ratio, ours over the best competitor, is ${cpu.pc.median.toFixed(2)} on the PC and ${cpu.mac.median.toFixed(2)} on the Mac. Our clearest leads are dense output at 16 terminals, repeated identical screens, sparse edits and queued output.
- **Mac energy.** Better by more than 10% in ${energy.ahead} of ${energy.total} cells, within 10% in ${energy.even}, worse in ${energy.lost.length}. Most losses are to Wraith, on full-screen redraws at 16 terminals and on light one-terminal work.
- **Write acknowledgement p95.** Worse by more than 10% and 0.5 ms in ${ack.pc.lost.length} of ${ack.pc.total} PC cells and ${ack.mac.lost.length} of ${ack.mac.total} Mac cells, all heavy 16-terminal parsing.
- **Download size.** ${sizeSummary(data.size)}
- **Cold load to first painted terminal.** ${loadLeaders(data, 'pc', 'unthrottled')}. ${loadLeaders(data, 'pc', 'fast4g')}. ${loadLeaders(data, 'mac', 'unthrottled')}. ${loadLeaders(data, 'mac', 'fast4g')}.

### Where a competitor still wins

CPU, PC:

${lossList(cpu.pc.lost, 's', 3)}

CPU, Mac:

${lossList(cpu.mac.lost, 's', 3)}

Mac energy:

${lossList(energy.lost, 'J', 3)}

Write acknowledgement p95, PC (the Mac has none):

${lossList(ack.pc.lost, 'ms', 2)}

Forced draw to GPU completion p95 (only ours and Wraith can force a draw), PC:

${lossList(forced.pc.lost, 'ms', 2)}

On glyph churn our rasterizer still draws each new glyph twice to detect colour glyphs. Cold cache can only be compared with xterm.js, the one competitor with a public glyph-atlas reset. The acknowledgement losses are all heavy parsing at 16 terminals: our main entry parses on the page's thread before it answers, and our worker pool shares 4 workers across the 16 terminals. One worker per terminal answers sooner but costs about 35 to 60% more CPU, so the pool keeps 4. The one-terminal losses are absolute gaps of a few to 90 milliseconds or millijoules, and those cells move by about 10% between sessions, so they can flip in a repeat.

On the PC, our main-thread WebGPU renderer costs more CPU than our WebGL2 renderer (Chrome on Linux presents each WebGPU canvas separately, which we reproduced without our code), so the auto backend picks WebGL2 on desktop Linux. Main WebGL2 is our best backend in ${webgl2Best('pc')} of ${cpu.pc.total} PC cells and ${webgl2Best('mac')} of ${cpu.mac.total} Mac cells; the tables below show every backend.

### How it was measured

- **Same work for everyone.** Every library gets the same bytes, a 100x30 grid, the same JetBrains Mono Regular TTF at 14 px and the same DPR. History is capped at 10,000 lines for ours, xterm.js and Wraith, and at a 64 MiB scrollback budget for ghostty-web and Restty, which limit history by bytes. Final screen text is compared across libraries, and a cell whose text differs is excluded.
- **Paced pass** (CPU, energy, acknowledgement): each cell is one workload at 1 or 16 terminals, 64 steps. A step writes one chunk to every terminal, waits until every terminal has acknowledged parsing it, then waits one display frame. Acknowledgement time runs from the start of that batch until the last terminal acknowledges. Afterwards every library drains and every arm waits two more frames.
- **Overload pass**: write-queue-overload queues the whole corpus at once, unpaced, and records each queued write's own acknowledgement.
- **Forced pass** (ours on the main entry and Wraith, the only libraries that can force a draw): 32 steps, each timed from the start of the write batch until the GPU reports the forced draw complete.
- **Display check.** Before and after every run each terminal is filled with a known colour. The check confirms that each terminal's drawing surface lies inside its section and the viewport, is visible with an intersection ratio of at least 0.99, and is not covered at five sampled points. It then requires compositor draw or swap events in a browser trace across the fill. Those events are browser-wide, so they show the browser drew a frame, not that each terminal's own pixels reached the screen. A failed check before a run stops it before measuring; a failed check after a run is recorded with the run. All ${data.speed.pc.runs} runs on the PC and ${data.speed.mac.runs} on the Mac passed both checks.
- **CPU** is on-CPU time of the whole browser process family (browser, renderer, GPU, utility and worker processes) for the delivered work, not a percentage. Linux sums per-thread \`schedstat\`; the Mac sums \`proc_pid_rusage\` user and system time.
- **Mac energy** is the macOS kernel's per-process CPU energy estimate (\`proc_pid_rusage\`, \`RUSAGE_INFO_V6\`) over the same process family. It excludes GPU-device, display and whole-system power.
- **Two repetitions** per cell in ABBA order; each value is their mean. Repetition-to-repetition CPU spread was 4% median and 8% at p75, so a gap under 10% counts as even. One-terminal cells are about 0.1 s of CPU and vary by about 10% between sessions.
- **Our arms** were run on \`${short}\`. Competitor arms come from a session a few hours earlier on the same machines with the same harness, bytes and page; two of them, xterm.js WebGL and Wraith, were re-run alongside ours as a drift check and moved a median ${data.drift.pc.toFixed(3)} (PC) and ${data.drift.mac.toFixed(3)} (Mac).
- **Not equal across libraries.** Cell sizes are each library's own (ours and xterm.js 8x21 CSS px, Wraith 8.5x17, Restty 8.5x18.5, ghostty-web 9x16), so ours and xterm.js paint about 19% more pixels than Wraith and ghostty-web. Wraith runs one worker and GPU device per terminal; our worker entry does too, our pool shares 4 workers; our main entry and the others use the page's thread. Ligatures are off and bold is synthesized everywhere.

<details>
<summary>The 17 workloads</summary>

${Object.entries(WORKLOADS)
  .map(([id, description]) => `- \`${id}\`: ${description}.`)
  .join('\n')}

</details>

### Whole-browser CPU, PC

CPU seconds for the delivered work, lower is better. Each library column is that library's best backend. Bold ratios are losses by more than 10%.

${comparisonTable(rowsOf(data, 'pc', 'cpu'), 3)}

${fullTables('pc', 'PC CPU seconds')}

### Whole-browser CPU, Mac

${comparisonTable(rowsOf(data, 'mac', 'cpu'), 3)}

${fullTables('mac', 'Mac CPU seconds')}

### Mac energy

Joules for the whole browser process family, lower is better.

${comparisonTable(rowsOf(data, 'mac', 'energy'), 3)}

<details>
<summary>Mac energy: every backend</summary>

${fullTable(rowsOf(data, 'mac', 'energy'), 3)}

</details>

### Download size

KiB that one terminal on its best renderer downloads, built with the same Vite production config and logged by the server while the page loads in Chromium. Brotli is quality 11. Fonts are counted separately: xterm.js, ghostty-web and our main entry draw with the page's \`monospace\` font; our worker entry and Restty get the same 21 KiB woff2, and Wraith fetches its bundled TTF.

${sizeTable(data.size)}

### Cold load

Milliseconds from navigation to the first compositor frame that shows a probe line written right after the terminal is created, median (p95) of 10 runs, each in a fresh headed Chromium profile with no HTTP or code cache, at device scale factor 2. Fast 4G adds 165 ms before every response and shares a 1.01 MB/s downlink. This setup differs from the speed runs: each app gets a 720x400 CSS px box; xterm.js, ghostty-web and Wraith are created at 80x20 cells and ours and Restty fit the box at 14 px (about 83x22). Ours on the main entry, xterm.js and ghostty-web draw with the page's \`monospace\` font; the others fetch a font file. The main entry paints its first frame on Canvas 2D while its GPU renderer starts (\`canvas2d → webgl2\` on the PC, \`canvas2d → webgpu\` on the Mac${coldLoadShort ? `; main-entry cold-load and transfer rows refreshed after Canvas-first startup landed in \`${coldLoadShort}\`` : ''}).

${coldLoadNotes(data)} On Fast 4G our main entry needs two serial round trips before it can request its external wasm file, and that wasm is most of its download. Wraith's xterm profile paints its first text through the DOM while its WebGPU renderer is still starting, so its first paint does not wait for its larger download. On the PC, our main entry avoids WebGL2 startup latency by painting first on Canvas 2D (80 to 82 ms median unthrottled), while xterm.js WebGL2 remains bimodal around 222 or 270 ms per load.

${loadTable(data)}

### What could not be measured

- xterm.js 6 has no canvas renderer, and our worker entry offers only WebGPU and WebGL2.
- Cold cache needs a public glyph-atlas reset, which only ours and xterm.js have.
- ghostty-web's wasm crashes on write-queue-overload (\`memory access out of bounds\`) at 1 and 16 terminals.
- On glyph churn, xterm.js measures 🧪 as one cell and ghostty-web's final rows are wrong, so their cells are excluded.
`
}

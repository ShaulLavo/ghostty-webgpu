import assert from 'node:assert/strict'
import { counterparts } from './comparison-options.mjs'
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { dirname, relative, resolve } from 'node:path'

export function quantile(values, percentile) {
  assert(values.length > 0 && values.every(Number.isFinite), 'Finite samples required')
  const sorted = [...values].sort((a, b) => a - b)
  if (percentile === 0.5) {
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
  }
  return sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)]
}

export function order(variants, repetition) {
  const offset = Math.floor(repetition / 2) % variants.length
  const rotated = [...variants.slice(offset), ...variants.slice(0, offset)]
  return repetition % 2 ? rotated.reverse() : rotated
}

export function droppedFrames(intervals, period) {
  assert(period > 0 && Number.isFinite(period))
  return intervals.reduce(
    (sum, interval) => sum + Math.max(0, Math.round(interval / period) - 1),
    0,
  )
}

function phaseMeasured(artifact, metric) {
  if (!artifact.phases) return true
  const prefix = metric.split('/')[0]
  const phase = { parse: 'parser', write: 'latency', input: 'latency' }[prefix] ?? prefix
  if (metric.startsWith('memory/output/') && !artifact.phases.includes('output')) return false
  return artifact.phases.includes(phase)
}

function omittedMetrics(artifact) {
  if (!artifact.phases) return []
  const metrics = [
    ...(artifact.fixtures ?? artifact.manifest.fixtures?.map(({ name }) => name) ?? []).flatMap(
      (name) => [
        `parse/${name}`,
        `burst/${name}/p50`,
        `burst/${name}/p95`,
        `burst/${name}/dropped`,
      ],
    ),
    'write/p50',
    'write/p95',
    'input/p50',
    'input/p95',
    'idle/cpu',
    'idle/cpu/renderer',
    'output/cpu',
    'output/cpu/renderer',
    'memory/terminal',
    'memory/10k',
    'memory/output/terminal',
    ...['initial', 'history', 'output'].flatMap((state) => [
      `memory/${state}/wasm`,
      `memory/${state}/rss-delta`,
    ]),
  ]
  return metrics.filter((metric) => !phaseMeasured(artifact, metric))
}

export function summaries(artifact) {
  const groups = new Map()
  const add = (run, metric, value, unit) => {
    if (!phaseMeasured(artifact, metric) || !Number.isFinite(value)) return
    const key = [run.variant, run.frameBuilder ?? '', run.path, run.count, metric].join('/')
    if (!groups.has(key))
      groups.set(key, {
        variant: run.frameBuilder ? `${run.variant}-${run.frameBuilder}` : run.variant,
        path: run.path,
        count: run.count,
        metric,
        unit,
        values: [],
      })
    groups.get(key).values.push(value)
  }
  for (const run of artifact.runs) {
    if (run.gpuIdle?.qualified === false) continue
    for (const [name, sample] of Object.entries(run.parse ?? {})) {
      if (sample.validation?.qualified !== true) continue
      add(run, `parse/${name}`, sample.bytes / sample.milliseconds / 1000, 'MB/s')
    }
    if (run.error) continue
    for (const name of ['write', 'input']) {
      if (!run.latency?.[name]?.length) continue
      add(run, `${name}/p50`, quantile(run.latency[name], 0.5), 'ms')
      add(run, `${name}/p95`, quantile(run.latency[name], 0.95), 'ms')
    }
    for (const [name, sample] of Object.entries(run.burst ?? {})) {
      add(run, `burst/${name}/p50`, quantile(sample.intervals, 0.5), 'ms')
      add(run, `burst/${name}/p95`, quantile(sample.intervals, 0.95), 'ms')
      add(
        run,
        `burst/${name}/dropped`,
        droppedFrames(sample.intervals, run.refreshPeriod),
        'frames',
      )
    }
    for (const state of ['idle', 'output']) {
      if (!run[state]) continue
      add(run, `${state}/cpu`, run[state].cpu.percentOfOneCore, '% core')
      add(run, `${state}/cpu/renderer`, rendererCpu(run[state].cpu), '% core')
    }
    const memory = run.memory
    if (!memory) continue
    const retained = (snapshot) => snapshot.heap.usedSize + (snapshot.heap.backingStorageSize ?? 0)
    add(
      run,
      'memory/terminal',
      (retained(memory.initial) - retained(memory.empty)) / run.count / 1048576,
      'MiB',
    )
    add(
      run,
      'memory/10k',
      (retained(memory.history) - retained(memory.initial)) / run.count / 1048576,
      'MiB',
    )
    const states = { initial: memory.initial, history: memory.history }
    if (run.output?.memory) {
      states.output = run.output.memory
      add(
        run,
        'memory/output/terminal',
        (retained(states.output) - retained(memory.empty)) / run.count / 1048576,
        'MiB',
      )
    }
    for (const [state, snapshot] of Object.entries(states)) {
      add(run, `memory/${state}/wasm`, snapshot.wasmBytes / 1048576, 'MiB total')
      if (snapshot.rssBytes != null && memory.empty.rssBytes != null)
        add(
          run,
          `memory/${state}/rss-delta`,
          (snapshot.rssBytes - memory.empty.rssBytes) / 1048576,
          'MiB total',
        )
    }
  }
  return Array.from(groups.values(), (group) => ({
    ...group,
    median: quantile(group.values, 0.5),
    repetitions: group.values.length,
  }))
}

function rendererCpu(cpu) {
  if (!cpu || !(cpu.milliseconds > 0)) return undefined
  const seconds = cpu.secondsByType?.renderer
  return Number.isFinite(seconds) ? (seconds / cpu.milliseconds) * 100_000 : undefined
}

const pairedMetrics = [
  ...['idle', 'output'].flatMap((state) => [
    {
      metric: `${state}/cpu/renderer`,
      unit: '% core',
      read: (run) => rendererCpu(run[state]?.cpu),
      cpu: (run) => ({
        sample: run[state]?.cpu,
        seconds: run[state]?.cpu?.secondsByType?.renderer,
      }),
    },
    {
      metric: `${state}/cpu/total`,
      unit: '% core',
      read: (run) => run[state]?.cpu?.percentOfOneCore,
      cpu: (run) => ({
        sample: run[state]?.cpu,
        seconds: Object.values(run[state]?.cpu?.secondsByType ?? {}).reduce(
          (sum, seconds) => sum + seconds,
          0,
        ),
      }),
    },
  ]),
  ...[
    ['input', 0.5],
    ['input', 0.95],
    ['write', 0.5],
  ].map(([name, percentile]) => ({
    metric: `${name}/p${percentile * 100}`,
    unit: 'ms',
    read: (run) =>
      run.latency?.[name]?.length ? quantile(run.latency[name], percentile) : undefined,
  })),
]

function pairKey(run) {
  if (
    typeof run.pairId !== 'string' ||
    !run.pairId ||
    typeof run.sessionId !== 'string' ||
    !run.sessionId ||
    !Number.isInteger(run.repetition)
  )
    return null
  return JSON.stringify([run.sessionId, run.pairId, run.repetition, run.path, run.count])
}

function pairedValues(native, other, { read, cpu }, minimumCpuTicks) {
  if (
    native.error ||
    other.error ||
    native.gpuIdle?.qualified === false ||
    other.gpuIdle?.qualified === false
  )
    return null
  const nativeValue = read(native)
  const counterpartValue = read(other)
  if (![nativeValue, counterpartValue].every((value) => Number.isFinite(value) && value >= 0))
    return null
  const ratio = counterpartValue > 0 ? nativeValue / counterpartValue : null
  let ratioReason
  if (ratio === null)
    ratioReason = nativeValue === 0 ? 'both sides are zero' : 'counterpart baseline is zero'
  const gpuSkipped = [native.gpuIdle?.skipped, other.gpuIdle?.skipped].filter(Boolean)
  let reason = ratioReason
  let ticks
  if (cpu) {
    const samples = [cpu(native), cpu(other)]
    ticks = samples.map(({ sample, seconds }) =>
      sample?.tickSeconds > 0 ? Math.round(seconds / sample.tickSeconds) : null,
    )
    if (ticks.includes(null)) reason = 'CPU tick resolution is unrecorded'
    else if (ticks.some((value) => value < minimumCpuTicks))
      reason = `CPU sample has fewer than ${minimumCpuTicks} ticks per side`
    else if (Math.abs(ticks[0] - ticks[1]) <= 1) reason = 'CPU sides differ by at most one tick'
  }
  let status = ratio <= 1 ? 'pass' : 'fail'
  if (reason) status = 'unresolved'
  if (!cpu && nativeValue > 0 && counterpartValue === 0) status = 'fail'
  return {
    pairId: native.pairId,
    sessionId: native.sessionId,
    repetition: native.repetition,
    native: nativeValue,
    counterpart: counterpartValue,
    ratio,
    ratioReason,
    ticks,
    status,
    reason,
    gpuSkipped,
  }
}

function ratioMedian(pairs) {
  if (!pairs.length) return null
  const sorted = pairs
    .map(
      ({ ratio, ratioReason }) =>
        ratio ?? (ratioReason === 'counterpart baseline is zero' ? Infinity : NaN),
    )
    .sort((a, b) => a - b)
  if (sorted.some(Number.isNaN)) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function pairedRow(
  groups,
  condition,
  nativeVariant,
  variant,
  definition,
  repetitions,
  minimumCpuTicks,
  frameBuilder,
  measured,
) {
  const { metric, unit } = definition
  const pairs = []
  for (const group of groups.values()) {
    const native = group.get(nativeVariant)?.filter((run) => run.frameBuilder === frameBuilder)
    const other = group.get(variant)
    if (!measured || native?.length !== 1 || other?.length !== 1) continue
    if (native[0].path !== condition.path || native[0].count !== condition.count) continue
    const pair = pairedValues(native[0], other[0], definition, minimumCpuTicks)
    if (pair) pairs.push(pair)
  }
  pairs.sort((a, b) => a.repetition - b.repetition)
  const complete =
    repetitions > 0 &&
    pairs.length === repetitions &&
    pairs.every((pair, index) => pair.repetition === index)
  const median = ratioMedian(pairs)
  let status = 'incomplete'
  if (complete) status = median <= 1 ? 'pass' : 'fail'
  if (complete && pairs.some((pair) => pair.status === 'unresolved')) status = 'unresolved'
  if (!measured) status = 'not measured'
  let medianReason
  if (median === Infinity) medianReason = 'unbounded: counterpart baseline is zero'
  if (median === null) medianReason = 'ratio unavailable'
  const gpuSkipped = [...new Set(pairs.flatMap((pair) => pair.gpuSkipped))]
  return {
    ...condition,
    nativeVariant,
    variant,
    ...(frameBuilder ? { frameBuilder } : {}),
    metric,
    unit,
    target: 1,
    pairs,
    median: Number.isFinite(median) ? median : null,
    medianReason,
    repetitions: pairs.length,
    status,
    gpuSkipped,
  }
}

function hasPairConfiguration(artifact) {
  return (
    Array.isArray(artifact.variants) &&
    Array.isArray(artifact.paths) &&
    Array.isArray(artifact.counts)
  )
}

function frameBuilderTreatments(artifact, variant) {
  if (!['ghostty-webgpu', 'ghostty-webgl'].includes(variant)) return [undefined]
  const observed = [
    ...new Set(
      artifact.runs.filter((run) => run.variant === variant).map((run) => run.frameBuilder),
    ),
  ]
  // Historical unlabeled evidence stays separate from explicitly selected treatments.
  if (observed.includes(undefined)) return observed
  const builders = artifact.frameBuilders ?? observed
  return builders.length ? builders : [undefined]
}

export function pairedRatios(artifact) {
  if (!hasPairConfiguration(artifact)) return []
  const groups = new Map()
  for (const run of artifact.runs) {
    const key = pairKey(run)
    if (key === null) continue
    if (!groups.has(key)) groups.set(key, new Map())
    const variants = groups.get(key)
    if (!variants.has(run.variant)) variants.set(run.variant, [])
    variants.get(run.variant).push(run)
  }
  const conditions = new Map(
    artifact.runs.map((run) => [
      JSON.stringify([run.path, run.count]),
      { path: run.path, count: run.count },
    ]),
  )
  for (const count of artifact.counts) {
    for (const path of artifact.paths)
      conditions.set(JSON.stringify([path, count]), { path, count })
  }
  const rows = []
  const treatments = artifact.variants
    .filter((id) => counterparts[id])
    .flatMap((nativeVariant) => {
      const variant = counterparts[nativeVariant]
      if (!artifact.variants.includes(variant)) return []
      return frameBuilderTreatments(artifact, nativeVariant).map((frameBuilder) => ({
        nativeVariant,
        variant,
        frameBuilder,
      }))
    })
  for (const condition of conditions.values()) {
    for (const { nativeVariant, variant, frameBuilder } of treatments) {
      rows.push(
        ...pairedMetrics.map((metric) =>
          pairedRow(
            groups,
            condition,
            nativeVariant,
            variant,
            metric,
            artifact.repetitions,
            artifact.manifest.settings.minimumCpuTicks ?? 100,
            frameBuilder,
            phaseMeasured(artifact, metric.metric),
          ),
        ),
      )
    }
  }
  return rows
}

const number = (value) => (value === null ? 'unbounded/unavailable' : value.toFixed(2))

function pairedMedian(row) {
  if (row.status === 'not measured') return 'not measured'
  if (row.median === null) return row.medianReason
  return number(row.median)
}

function pairedMarkdown(artifact) {
  if (!hasPairConfiguration(artifact))
    return [
      '## Paired pass rule',
      '',
      'This artifact predates the selected variants, paths, or counts fields. Paired evaluation is skipped.',
      '',
    ]
  const rows = pairedRatios(artifact)
  const lines = [
    '## Paired pass rule',
    '',
    'xterm removed its canvas renderer. ghostty-web is the closest available canvas 2D counterpart for ghostty-canvas; their parsers and host adapters differ.',
    'Targets are native/counterpart ratios ≤ 1 for renderer CPU, total Chromium CPU, input p50/p95, and write p50 in every path/count condition. Each pair shares its browser session ID, pair ID, repetition, path, and terminal count. The median of the individual pair ratios determines pass or fail; absolute measurements provide context.',
    'Every configured repetition must have exactly one qualified native and counterpart run. Missing IDs, duplicate runs, failures, missing metrics, and rejected GPU-idle runs leave the condition incomplete. CPU pairs are unresolved when either side has fewer than the configured minimum ticks or sides differ by at most one tick. Zero/zero never passes. Unbounded ratios are null with a reason. Skipped GPU qualification is explicitly labeled.',
    '',
    '| Terminals | Path | Native ↔ counterpart | Measure | Median ratio | Target | Pairs | Status |',
    '| ---: | --- | --- | --- | ---: | ---: | ---: | --- |',
  ]
  for (const row of rows)
    lines.push(
      `| ${row.count} | ${row.path} | ${row.nativeVariant}${row.frameBuilder ? `-${row.frameBuilder}` : ''} ↔ ${row.variant} | ${row.metric} | ${pairedMedian(row)} | ${row.status === 'not measured' ? '—' : '≤ 1'} | ${row.status === 'not measured' ? '—' : `${row.repetitions}/${artifact.repetitions}`} | ${row.status}${row.gpuSkipped.length ? ` (GPU unqualified: ${row.gpuSkipped.join('; ')})` : ''} |`,
    )
  lines.push(
    '',
    '### Individual pairs',
    '',
    '| Terminals | Path | Native ↔ counterpart | Measure | Pair ID | Repetition | Native | Counterpart | Ratio | Resolution |',
    '| ---: | --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |',
  )
  for (const row of rows) {
    for (const pair of row.pairs)
      lines.push(
        `| ${row.count} | ${row.path} | ${row.nativeVariant}${row.frameBuilder ? `-${row.frameBuilder}` : ''} ↔ ${row.variant} | ${row.metric} | ${pair.pairId.replaceAll('|', '\\|').replaceAll('\n', ' ')} | ${pair.repetition + 1} | ${number(pair.native)} ${row.unit} | ${number(pair.counterpart)} ${row.unit} | ${number(pair.ratio)} | ${pair.status}${pair.reason ? `: ${pair.reason}` : ''}${pair.ticks ? ` (${pair.ticks.join('/')} ticks)` : ''} |`,
      )
  }
  return lines
}

export function markdown(artifact, review = {}, artifactDirectory = '.') {
  const link = (path) => (artifactDirectory === '.' ? path : `${artifactDirectory}/${path}`)
  assert(
    !artifact.smoke && artifact.hardware,
    'Correctness smoke cannot generate performance claims',
  )
  const rows = summaries(artifact).filter((row) => row.repetitions === artifact.repetitions)
  const builders = artifact.frameBuilders ?? [
    ...new Set(
      artifact.runs
        .filter((run) => ['ghostty-webgpu', 'ghostty-webgl'].includes(run.variant))
        .map((run) => run.frameBuilder ?? 'unlabeled'),
    ),
  ]
  const lines = [
    '# Terminal comparison benchmarks',
    '',
    'Generated from the checked-in JSON artifact. Lower is better except parse throughput.',
    'Tracing instrumentation is loaded in every hardware run, including CPU and burst windows; inactive wrappers differ by renderer. These measurements are distinct from historical uninstrumented runs.',
    '',
    '## Run it',
    '',
    'From `ghostty-webgpu`, run `bun run bench:compare -- --bundle /path/to/bundle` to build and measure.',
    'Use `bun run bench:compare -- --smoke --bundle /path/to/bundle` for correctness only.',
    'Use `bun run bench:compare -- --build-only --bundle /path/to/bundle` for a portable Node bundle.',
    'On the target machine, enter that bundle and run `npm install --ignore-scripts`,',
    '`npx playwright install chromium`, then `node comparison-runner.mjs --smoke`.',
    'Run `node comparison-runner.mjs --output results` on AC power for measurements.',
    'Linux hardware runs use Vulkan Chromium headless-shell; macOS hardware runs open headed Chromium windows. Select one count and path per quiet window; the configured matrix has a bounded budget of ten minutes per case.',
    'Regenerate the checked-in report with `node scripts/comparison-report.mjs docs/benchmarks/mac-m1/comparison.json docs/benchmarks.md docs/benchmarks/mac-m1/review.json`.',
    '',
    '## Environment',
    '',
    `- Benchmark checkout commit: \`${artifact.manifest.commit}\`. Combined source SHA-256: \`${artifact.manifest.sourceSha256}\`.`,
    ...(artifact.manifest.runtime
      ? [
          `- Runtime: ${artifact.manifest.runtime.mode} at \`${artifact.manifest.runtime.commit}\`. Runtime source SHA-256: \`${artifact.manifest.runtime.sourceSha256}\`.`,
          `- Benchmark source SHA-256: \`${artifact.manifest.benchmark.sourceSha256}\`. Bundle SHA-256: \`${artifact.manifest.bundleSha256}\`.`,
        ]
      : []),
    `- Output fixture: ${artifact.outputFixture ?? 'ascii'}. Frames: ${artifact.outputFrames ?? artifact.manifest.settings.outputFrames}.`,
    `- Browser: ${artifact.environment.browser}. OS: ${artifact.environment.os}.`,
    `- Latency endpoint: ${artifact.environment.latencyEndpoint}. Samples per operation/repetition: ${artifact.latencySamples}.`,
    `- GPU: ${artifact.environment.renderer}. Hardware adapter: ${artifact.hardware}. Headless: ${artifact.environment.headless ?? false}.`,
    `- Font: JetBrains Mono ${artifact.manifest.versions['@fontsource/jetbrains-mono']}, bundled regular/bold Latin faces. Emoji and CJK use the same OS fallback fonts.`,
    `- Font size: ${artifact.manifest.settings.fontSize}px. DPR: ${artifact.manifest.settings.dpr}. Grid: ${artifact.manifest.settings.columns} × ${artifact.manifest.settings.rows}.`,
    `- Libraries: ghostty-webgpu ${artifact.manifest.versions['ghostty-webgpu']}; xterm ${artifact.manifest.versions['@xterm/xterm']} with WebGL addon ${artifact.manifest.versions['@xterm/addon-webgl']}; ghostty-web ${artifact.manifest.versions['ghostty-web']}.`,
    `- Selected phases: ${(artifact.phases ?? ['parser', 'memory', 'idle', 'latency', 'burst', 'output']).join(', ')}. Omitted-phase metrics are not measured.`,
    `- Selected variants: ${(artifact.variants ?? []).join(', ')}. GPU frame builders: ${builders.join(', ')}.`,
    `- Repetitions: ${artifact.repetitions}. Each table cell is the median of the per-run result, including per-run p50/p95.`,
    `- Artifact: [comparison.json](${link('comparison.json')}).`,
    '',
    '## Method',
    '',
    'Each case opens a fresh browser context. All 1, 8, or 17 terminals remain visible in a fixed grid.',
    'Library order alternates forward/reverse between repetitions and rotates on the third repetition.',
    'Byte/string paths alternate too. A warmup precedes each timed operation.',
    'Chromium launches with a device scale of 2 so resize-observer backing pixels agree with DPR.',
    'Its WebGL context limit is 32 for every case, allowing all 17 xterm WebGL terminals to remain live.',
    'Parse throughput uses unopened parsers and complete UTF-8 corpora in 4 KiB chunks.',
    'Parser-only contexts run before any rendered terminal is created. Timing covers synchronous input decoding/encoding, VT parsing, and buffer writes.',
    'xterm uses its pinned 6.0.0 input-handler parse boundary, bypassing WriteBuffer timers; both Ghostty libraries use synchronous core writes.',
    'A parser returning asynchronous work is rejected. No callback, microtask, or timer wait is included in isolated-parser timing.',
    'After timing, the same instance must match independent expected viewport text, cursor, and SGR color/style probes. Unqualified samples are excluded.',
    'Qualification covers the final viewport and cursor; the alternate screen keeps no offscreen history. Separate one-byte smoke diagnostics are retained even when 4 KiB results qualify.',
    'Text comparison permits NFC composition and trailing blank cells only; ZWJ characters must be retained. Smoke checks exercise both 4 KiB and one-byte chunks.',
    'Empty decoded chunks and an empty final decoder flush are omitted; a nonempty final flush remains part of the input.',
    'Each parse-only fixture owns a fresh WASM runtime. Runtime construction is outside timing for both Ghostty libraries.',
    'Every parse-only terminal enters the alternate screen before timing, so history allocation does not affect parser throughput.',
    'The string chunks are decoded before timing. String-to-WASM encoding remains inside the timed library call.',
    'MB means 1,000,000 bytes. The real-log fixture is an archived 256-entry public Git history log, repeated to at least 1 MiB.',
    'xterm DOM and WebGL share a parser; their parse results are independent repetitions of that same parser.',
    '',
    'Write latency starts at the browser write call. Input latency starts at the captured keydown event and crosses a loopback WebSocket byte echo.',
    'The endpoint recorded in each run identifies its presentation measurement. AnimationFrame::Presentation is correlated to the animation frame containing that terminal’s render span.',
    'PNG glyph captures qualify correctness. In headless-shell, presentation acknowledgement is on-demand and follows submission independently of physical vsync. Renderer rAF pacing still determines when a terminal can draw.',
    'GPU variants require a submitted glyph draw. Canvas and DOM variants require a real terminal row paint within the selected animation frame; deferred no-op frames are excluded.',
    'Physical-vsync and optical display latency are unmeasured. The optional --validate-presentation phase inserts one renderer rAF before write, and retains the delayed samples beside the ordinary samples.',
    'GPU windows retain utilization samples, owned/foreign compute-process memory, thresholds, and qualification. Their recorded idle and in-window limits allow the benchmark’s own measured load while bounding shared GPU saturation and foreign compute residency.',
    'Screencasting is stopped for burst, CPU, and memory measurements.',
    '',
    'Repeating fixtures write the same complete unit of at least 4 KiB per terminal per animation frame.',
    'rolling-logs advances through the real Git-history corpus in chunks of at most 4 KiB, ending between UTF-8 codepoints. The corpus tail is a shorter frame, then the stream wraps.',
    'Every burst resets to the corpus start, including the separate warmup. The fixture records corpus and length-framed cycle hashes; output records exact bytes and the final chunk offset.',
    'Every library uses exactly one shared animation-frame pacing wait per iteration. The synchronous ghostty-web public write receives no presentation callback.',
    'Frame intervals come from requestAnimationFrame timestamps. Dropped frames are inferred from the measured idle refresh period,',
    'rounded to the nearest number of display intervals. They are missed animation-frame opportunities, not GPU presentation counters.',
    'CPU sums Chromium process CPU time, including browser, renderer, and GPU, as a percentage of one core. Samples reject any process birth or exit.',
    'Every case has a 10-minute deadline capped by the remaining configured matrix budget; the heavy wrapper quiet hold is the outer limit. Timeout closes its contexts and retains the failure.',
    'Bundle and asset hashes are verified before serving; both font weights are loaded and checked before rendered phases.',
    'Successful latency phases retain metadata and colored-glyph classification for every screencast frame, including frames that did not qualify a sample.',
    'Failed latency phases retain the last capture image/metadata and a direct screenshot; their partial capture stream is not serialized.',
    '',
    'Memory per terminal and per 10k rows is the post-GC CDP used JS heap plus backing storage delta, divided by terminal count.',
    'Output memory is sampled after the selected output fixture and frame count, outside CPU timing. Initial memory is the idle baseline.',
    'This is retained JS/backing storage, not total terminal memory. WASM linear-memory capacity is reported separately.',
    'Renderer/GPU RSS deltas cover all Chromium processes and include browser allocation noise and shared resources.',
    'GPU allocation is not available per terminal. Negative deltas are retained as measurement noise.',
    'Each Ghostty library shares one WASM runtime per context, matching its supported multi-terminal use.',
    'The 10k fixture contains exactly 10,000 retained 40-column ASCII history rows per terminal.',
    'The native adapter sets upstream SCROLLBACK_MAX_BYTES to 64 MiB through the runtime ABI, in addition to the 10k line limit.',
    'The session API exposes the line limit only; the adapter checks its pinned internal terminal before applying the byte option.',
    'The default byte budget retained only 2,014 rows in the initial attempt. The final run asserts all 10k rows.',
    'ghostty-web also receives a 64 MiB budget: its 0.4.0 scrollback option is passed to the upstream max_scrollback byte field.',
    'At scrollback: 10000, it retained only 1,852 rows. Its pinned [patch](https://github.com/coder/ghostty-web/blob/9e4e126d/patches/ghostty-wasm-api.patch) documents that option as lines.',
    'xterm has a 10k row limit. Burst phases clear history first; legacy retention is byte-budget-only.',
    '',
    '## Results',
    '',
  ]
  const selectedVariants = artifact.variants ?? artifact.manifest.variants.map(({ id }) => id)
  const variants = selectedVariants.flatMap((id) =>
    frameBuilderTreatments(artifact, id).map((builder) => (builder ? `${id}-${builder}` : id)),
  )
  const cases = (artifact.counts ?? artifact.manifest.settings.counts).flatMap((count) =>
    (artifact.paths ?? ['bytes', 'string']).map((path) => ({ count, path })),
  )
  for (const { count, path } of cases) {
    lines.push(
      `### ${count} terminal${count === 1 ? '' : 's'}, ${path}`,
      '',
      `| Measure | ${variants.join(' | ')} |`,
      `| --- | ${variants.map(() => '---:').join(' | ')} |`,
    )
    const subset = rows.filter((row) => row.count === count && row.path === path)
    const metrics = [...new Set([...subset.map((row) => row.metric), ...omittedMetrics(artifact)])]
    for (const metric of metrics) {
      const cells = variants.map((id) => {
        const row = subset.find((entry) => entry.variant === id && entry.metric === metric)
        if (!phaseMeasured(artifact, metric)) return 'not measured'
        return row ? `${number(row.median)} ${row.unit}` : 'unmeasured'
      })
      lines.push(`| ${metric} | ${cells.join(' | ')} |`)
    }
    lines.push('')
  }
  lines.push(...pairedMarkdown(artifact))
  lines.push(
    '',
    '## Correctness and limits',
    '',
    'The runner asserts ASCII, SGR, wide text, cursor overwrite, byte echo, glyph presentation, and exact history length.',
    'Successful first-repetition correctness checks retain Unicode/ZWJ text and a screenshot.',
    'Review those screenshots for glyph layout differences; parser acceptance alone cannot prove Unicode shaping parity.',
    'Firefox and Safari were not measured. This run qualifies Chromium on the recorded hardware only.',
    'The corpus and font hashes, raw latency samples, raw frame intervals, process CPU snapshots, memory buckets,',
    'actual execution order, and failed cases are retained in JSON.',
    'GPU-idle rejected runs are excluded from all summaries and paired comparisons. Each validated isolated-parser corpus remains eligible independently of other parser or rendered failures. Other metrics from failed rendered cases are excluded. Absolute summary cells require all configured repetitions.',
    '',
  )
  const failures = new Map()
  for (const run of artifact.runs.filter((run) => run.error)) {
    const label = `${run.variant}/${run.path}/${run.count}`
    const message = run.error.split('\n')[0]
    const key = `${label}/${message}`
    if (!failures.has(key)) failures.set(key, { label, message, repetitions: [] })
    failures.get(key).repetitions.push(run.repetition + 1)
  }
  for (const failure of failures.values())
    lines.push(
      `- ${failure.label}, repetitions ${failure.repetitions.join(', ')}: ${failure.message}`,
    )
  for (const run of artifact.runs) {
    for (const failure of run.parserErrors ?? [])
      lines.push(
        `- ${run.variant}/${run.path}/${run.count}, parser ${failure.name}, repetition ${run.repetition + 1}: ${failure.error.split('\n')[0]}`,
      )
  }
  if (review.coverage) {
    lines.push('', '## Screenshot review', '', review.coverage, '')
    for (const observation of review.observations ?? []) lines.push(`- ${observation}`)
    lines.push('', '### Qualification notes', '')
    for (const limit of review.limits ?? []) lines.push(`- ${limit}`)
    lines.push('', '### Evidence', '')
    for (const link of review.links ?? [])
      lines.push(
        `- [${link.label}](${artifactDirectory === '.' ? link.path : `${artifactDirectory}/${link.path}`})`,
      )
  }
  return lines.join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const artifact = JSON.parse(await readFile(process.argv[2], 'utf8'))
  const review = process.argv[4] ? JSON.parse(await readFile(process.argv[4], 'utf8')) : {}
  const directory =
    relative(dirname(resolve(process.argv[3])), dirname(resolve(process.argv[2]))).replaceAll(
      '\\',
      '/',
    ) || '.'
  await writeFile(process.argv[3], markdown(artifact, review, directory))
}

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { quantile } from './comparison-report.mjs'
import { assertDisplay } from './comparison-trace.mjs'
import { analysisArguments, positiveInteger, counterparts } from './comparison-options.mjs'
import { renderedFrame, renderOperations } from './comparison-render.mjs'

export function unionMilliseconds(intervals) {
  const sorted = intervals
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .toSorted((a, b) => a[0] - b[0])
  let total = 0
  let right = -Infinity
  for (const [start, end] of sorted) {
    total += Math.max(0, end - Math.max(start, right))
    right = Math.max(right, end)
  }
  return total
}

export function mainThread(events, records) {
  const begin = events.find((event) => event.name === 'compare/begin')
  assert(begin, 'Trace begin marker required')
  const offset = begin.ts / 1000 - begin.args.data.startTime
  const start = records.markers.find((marker) => marker.operation === 'begin').time
  const end = records.markers.find((marker) => marker.operation === 'end').time
  assert(Number.isFinite(offset) && end > start, 'Finite trace clock and positive window required')
  const main = events
    .filter((event) => event.pid === begin.pid && event.tid === begin.tid)
    .toSorted((a, b) => a.ts - b.ts)
  const tasks = main.filter((event) => event.name === 'RunTask' && event.ph === 'X')
  assert(tasks.length, 'Renderer main task events required')
  const taskMilliseconds = unionMilliseconds(
    tasks.map((event) => [
      Math.max(start, event.ts / 1000 - offset),
      Math.min(end, (event.ts + event.dur) / 1000 - offset),
    ]),
  )
  assert(taskMilliseconds > 0, 'Positive renderer main task denominator required')
  const frames = []
  const pending = new Map()
  for (const event of main) {
    if (event.name !== 'AnimationFrame') continue
    const key = event.id2?.local
    if (event.ph === 'b') pending.set(key, event)
    if (event.ph !== 'e') continue
    const first = pending.get(key)
    if (!first) continue
    frames.push({
      start: first.ts / 1000 - offset,
      end: event.ts / 1000 - offset,
      id: first.args?.id,
    })
    pending.delete(key)
  }
  return { offset, main, taskMilliseconds, frames }
}

export function timelines(phase, clock) {
  const { records, sample } = phase
  if (!sample?.captures) return []
  const spans = records.spans
  const presentations = clock.main.filter((event) => event.name === 'AnimationFrame::Presentation')
  const boundaries = clock.main
    .filter((event) => event.name === 'AnimationFrame::Render' && event.ph === 'b')
    .map((event) => event.ts / 1000 - clock.offset)
  return sample.captures.map((capture, index) => {
    const { started, captured, echo, parse, frame, boundary } = renderedFrame(records, capture)
    const animation = clock.frames
      .filter(
        (candidate) =>
          candidate.start <= (frame?.start ?? started) && candidate.end >= (frame?.end ?? started),
      )
      .at(-1)
    const presented = animation && presentations.find((event) => event.args?.id === animation.id)
    const relative = (time) => (time === undefined ? null : time - started)
    return {
      index,
      operation: capture.operation,
      started,
      latency: captured - started,
      echo: relative(echo?.time),
      parse: relative(parse?.start),
      parseEnd: relative(parse?.end),
      frame: relative(frame?.start),
      frameEnd: relative(frame?.end),
      renderBoundary: boundary.operation,
      renderBoundaryEnd: relative(boundary.end),
      chromePresented: presented ? relative(presented.ts / 1000 - clock.offset) : null,
      animationId: animation?.id,
      previousBoundary: relative(boundaries.filter((time) => time <= started).at(-1)),
      boundariesBeforeFrame: boundaries
        .filter((time) => time > started && time < (frame?.start ?? started))
        .map(relative),
      terminalWork: spans
        .filter((span) => span.terminal === 0 && span.start >= started && span.end <= captured)
        .reduce((sum, span) => sum + span.self, 0),
      trace: phase.trace,
    }
  })
}

export function sampledProfile(events, clock, records) {
  const begin = clock.main.find((event) => event.name === 'compare/begin')
  const profile = clock.main.find((event) => event.name === 'Profile')
  if (!profile) return null
  const chunks = events
    .filter(
      (event) =>
        event.name === 'ProfileChunk' && event.pid === begin.pid && event.id === profile.id,
    )
    .toSorted((a, b) => a.ts - b.ts)
  const nodes = new Map()
  const samples = []
  const milliseconds = Object.create(null)
  const start = records.markers.find((marker) => marker.operation === 'begin').time + clock.offset
  const end = records.markers.find((marker) => marker.operation === 'end').time + clock.offset
  let time = profile.args.data.startTime / 1000
  assert(Number.isFinite(time), 'Finite CPU profile start required')
  for (const chunk of chunks) {
    const data = chunk.args.data
    for (const node of data.cpuProfile?.nodes ?? []) nodes.set(node.id, node)
    const ids = data.cpuProfile?.samples ?? []
    assert.equal(ids.length, data.timeDeltas?.length ?? 0, 'CPU samples require matching deltas')
    for (const [index, id] of ids.entries()) {
      assert(Number.isFinite(data.timeDeltas[index]), 'Finite CPU sample delta required')
      time += data.timeDeltas[index] / 1000
      samples.push({ time, id })
    }
  }
  // Chrome can deliver backwards sample deltas; chronological intervals must partition time once.
  samples.sort((a, b) => a.time - b.time)
  const tasks = []
  const ranges = clock.main
    .filter((event) => event.name === 'RunTask' && event.ph === 'X')
    .map((event) => [
      Math.max(start, event.ts / 1000),
      Math.min(end, (event.ts + event.dur) / 1000),
    ])
    .filter(([left, right]) => right > left)
    .toSorted((a, b) => a[0] - b[0])
  for (const range of ranges) {
    const previous = tasks.at(-1)
    if (previous && range[0] <= previous[1]) {
      previous[1] = Math.max(previous[1], range[1])
      continue
    }
    tasks.push(range)
  }
  let taskIndex = 0
  for (const [index, sample] of samples.entries()) {
    const left = Math.max(start, sample.time)
    const right = Math.min(end, samples[index + 1]?.time ?? sample.time)
    if (right <= left) continue
    while (taskIndex < tasks.length && tasks[taskIndex][1] <= left) taskIndex++
    let duration = 0
    for (let cursor = taskIndex; cursor < tasks.length && tasks[cursor][0] < right; cursor++) {
      duration += Math.max(0, Math.min(right, tasks[cursor][1]) - Math.max(left, tasks[cursor][0]))
    }
    if (!duration) continue
    const name = nodes.get(sample.id)?.callFrame.functionName ?? '(unknown)'
    milliseconds[name] = (milliseconds[name] ?? 0) + duration
  }
  const covered = Object.values(milliseconds).reduce((sum, value) => sum + value, 0)
  const unsampled = Math.max(0, unionMilliseconds(tasks) - covered)
  if (unsampled) milliseconds['(unsampled)'] = (milliseconds['(unsampled)'] ?? 0) + unsampled
  return Object.fromEntries(Object.entries(milliseconds).toSorted((a, b) => b[1] - a[1]))
}

export function frameCadence(records, clock) {
  const paced = records.markers
    .filter((marker) => marker.operation === 'paced-frame')
    .map((marker) => marker.detail.timestamp)
  const periods = paced.slice(1).map((time, index) => time - paced[index])
  const renders = records.spans.filter((span) => renderOperations.includes(span.operation))
  const workByFrame = new Map()
  for (const span of renders) {
    const frame = clock.frames.findLast(
      (candidate) => span.start >= candidate.start && span.end <= candidate.end,
    )
    if (!frame) continue
    workByFrame.set(frame, (workByFrame.get(frame) ?? 0) + span.end - span.start)
  }
  const work = [...workByFrame.values()]
  const stats = (values) => ({
    samples: values.length,
    p50: values.length ? quantile(values, 0.5) : null,
    p95: values.length ? quantile(values, 0.95) : null,
    max: values.length ? Math.max(...values) : null,
  })
  return { pacedIntervals: stats(periods), terminalWorkPerAnimationFrame: stats(work) }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function cpuIntervalQualified(cpu) {
  if (!cpu?.interval) return false
  const { before, after } = cpu.interval
  const times = [before?.requested, before?.completed, after?.requested, after?.completed]
  assert(
    times.every(Number.isFinite) &&
      times.every((time, index) => index === 0 || time >= times[index - 1]),
    'Incomplete CPU acquisition brackets',
  )
  const interval = (after.requested + after.completed - before.requested - before.completed) / 2
  assert(
    interval > 0 && Math.abs(interval - cpu.milliseconds) < 1e-6,
    'Mismatched CPU sampling interval',
  )
  return true
}

function validatePhase(phase, name, artifact) {
  assert(!phase.error, 'Failed phase cannot qualify as attribution evidence')
  assert(Number.isFinite(phase.milliseconds) && phase.milliseconds > 0, 'Incomplete phase timing')
  assert(Number.isFinite(phase.cpu?.percentOfOneCore), 'Incomplete CPU evidence')
  cpuIntervalQualified(phase.cpu)
  if (phase.traced)
    assert(phase.records && phase.summary && phase.trace, 'Incomplete trace evidence')
  const args = artifact.environment?.arguments ?? []
  if (name !== 'latency') {
    const frames = artifact.traceFrames ?? positiveInteger(args, '--trace-frames', 180)
    assert(phase.sample?.intervals?.length === frames, 'Incomplete output samples')
    return
  }
  const samples =
    artifact.traceLatencySamples ?? positiveInteger(args, '--trace-latency-samples', 48)
  assert(
    phase.sample?.write?.length === samples && phase.sample?.input?.length === samples,
    'Incomplete latency samples',
  )
  assert(phase.sample.captures?.length === samples * 2, 'Incomplete captured-frame evidence')
}

function validateRun(run, artifact, phases) {
  assert(
    !run.error &&
      !run.pageErrors?.length &&
      !run.parserErrors?.length &&
      (run.status === undefined || run.status === 'complete'),
    'Failed run cannot qualify as attribution evidence',
  )
  assert(run.phases?.length === phases.length * 2, 'Incomplete phase pairs')
  for (const name of phases) {
    for (const traced of [false, true]) {
      const treatment = run.frameBuilder ? `${run.variant}-${run.frameBuilder}` : run.variant
      const label = `${treatment}-${run.count}-${run.repetition}-${name}-${traced ? 'trace' : 'control'}`
      const matches = run.phases.filter((phase) => phase.label === label && phase.traced === traced)
      assert(matches.length === 1, 'Incomplete or duplicate phase pair')
      validatePhase(matches[0], name, artifact)
    }
  }
  const probes = artifact.qualifications.filter(
    (probe) =>
      probe.variant === run.variant &&
      probe.frameBuilder === run.frameBuilder &&
      probe.count === run.count &&
      probe.repetition === run.repetition,
  )
  assert(
    probes.length === 2 + phases.length * 2 &&
      probes.filter((probe) => probe.kind === 'idle-display').length === 1,
    'Incomplete display evidence',
  )
  for (const probe of probes)
    assertDisplay(probe, {
      idle: probe.kind === 'idle-display',
      expectedPeriod: artifact.environment?.os?.startsWith('darwin') ? 16.67 : null,
    })
}

export function validateArtifact(artifact) {
  assert(
    artifact.hardware && artifact.tracing && !artifact.invalid && !artifact.error,
    'Failed or unqualified hardware trace artifact',
  )
  assert(
    Number.isFinite(Date.parse(artifact.startedAt)) &&
      Date.parse(artifact.finishedAt) > Date.parse(artifact.startedAt),
    'Incomplete measurement window',
  )
  assert(
    Number.isSafeInteger(artifact.repetitions) && artifact.repetitions >= 3,
    'Incomplete repetitions',
  )
  const args = artifact.environment?.arguments ?? []
  const counts =
    artifact.traceCounts ??
    (args.includes('--trace-count') ? [positiveInteger(args, '--trace-count', 1)] : [1, 8, 17])
  const phases = artifact.tracePhases ?? ['latency', 'ascii', 'sgr']
  assert(
    counts.length &&
      new Set(counts).size === counts.length &&
      counts.every((count) => [1, 8, 17].includes(count)),
    'Incomplete terminal-count matrix',
  )
  assert(
    phases.length &&
      new Set(phases).size === phases.length &&
      phases.every((name) =>
        ['latency', 'ascii', 'sgr', 'rolling-logs', 'rolling-unicode-logs'].includes(name),
      ),
    'Incomplete phase matrix',
  )
  assert(Array.isArray(artifact.qualifications), 'Incomplete display evidence')
  const variants = artifact.variants ?? ['ghostty-webgpu', 'xterm-webgl']
  const known = [...Object.keys(counterparts), ...new Set(Object.values(counterparts))]
  assert(
    variants.length &&
      new Set(variants).size === variants.length &&
      variants.every((id) => known.includes(id)),
    'Incomplete or unknown variant matrix',
  )
  const builders = artifact.frameBuilders ?? [undefined]
  assert(
    builders.length &&
      new Set(builders).size === builders.length &&
      builders.every((builder) => builder === undefined || ['js', 'zig'].includes(builder)),
    'Incomplete or unknown frame-builder matrix',
  )
  const identities = variants.flatMap((variant) => {
    const labels = ['ghostty-webgpu', 'ghostty-webgl'].includes(variant) ? builders : [undefined]
    return labels.map((builder) => ({ variant, builder }))
  })
  const expected = new Set()
  for (let repetition = 0; repetition < artifact.repetitions; repetition++) {
    for (const { variant, builder } of identities)
      for (const count of counts) expected.add(`${variant}/${builder ?? ''}/${count}/${repetition}`)
  }
  assert(artifact.runs?.length === expected.size, 'Incomplete case matrix')
  const slots = new Set()
  for (const run of artifact.runs) {
    assert(
      variants.includes(run.variant) &&
        (['ghostty-webgpu', 'ghostty-webgl'].includes(run.variant)
          ? builders.includes(run.frameBuilder)
          : run.frameBuilder === undefined) &&
        counts.includes(run.count) &&
        run.path === 'bytes' &&
        Number.isInteger(run.repetition) &&
        run.repetition >= 0 &&
        run.repetition < artifact.repetitions,
      'Incomplete or unexpected case',
    )
    const slot = `${run.variant}/${run.frameBuilder ?? ''}/${run.count}/${run.repetition}`
    assert(expected.has(slot), 'Incomplete or unexpected case')
    assert(!slots.has(slot), 'Incomplete or duplicate case matrix')
    slots.add(slot)
    validateRun(run, artifact, phases)
  }
}

export async function analyze(directory) {
  const contents = await readFile(join(directory, 'comparison.json'))
  const artifact = JSON.parse(contents)
  const fileHashes = { 'comparison.json': sha256(contents) }
  validateArtifact(artifact)
  const rows = []
  for (const run of artifact.runs) {
    for (const phase of run.phases ?? []) {
      const row = {
        variant: run.variant,
        frameBuilder: run.frameBuilder,
        count: run.count,
        repetition: run.repetition,
        label: phase.label,
        traced: phase.traced,
        error: phase.error,
        cpu: phase.cpu,
        cpuIntervalQualified: cpuIntervalQualified(phase.cpu),
        milliseconds: phase.milliseconds,
        grid: run.grid,
        window: run.window,
      }
      if (phase.records) {
        const bytes = await readFile(join(directory, phase.trace))
        fileHashes[phase.trace] = sha256(bytes)
        const trace = JSON.parse(gunzipSync(bytes))
        const clock = mainThread(trace.traceEvents, phase.records)
        row.summary = phase.summary
        row.mainTaskMilliseconds = clock.taskMilliseconds
        row.instrumentedShareOfMainTasks =
          (phase.summary.instrumentedMilliseconds / clock.taskMilliseconds) * 100
        row.timelines = timelines(phase, clock)
        row.frameCadence = frameCadence(phase.records, clock)
        row.sampledLeaves = sampledProfile(trace.traceEvents, clock, phase.records)
        row.trace = phase.trace
        row.byOperation = {}
        for (const span of phase.records.spans)
          row.byOperation[span.operation] = (row.byOperation[span.operation] ?? 0) + span.self
      }
      if (phase.sample?.write?.length)
        row.latency = Object.fromEntries(
          ['write', 'input']
            .filter((name) => phase.sample[name].length)
            .map((name) => [
              name,
              {
                samples: phase.sample[name].length,
                p50: quantile(phase.sample[name], 0.5),
                p95: quantile(phase.sample[name], 0.95),
              },
            ]),
        )
      rows.push(row)
    }
  }
  return {
    environment: artifact.environment,
    manifest: artifact.manifest,
    qualifications: artifact.qualifications,
    startedAt: artifact.startedAt,
    finishedAt: artifact.finishedAt,
    fileHashes,
    rows,
  }
}

export function compactAnalysis(analysis) {
  return {
    ...analysis,
    qualifications: analysis.qualifications.map(({ periods, ...probe }) =>
      periods === undefined ? probe : { ...probe, periodsSha256: sha256(JSON.stringify(periods)) },
    ),
    rows: analysis.rows.map((row) => {
      const { before: _before, after: _after, ...cpu } = row.cpu
      if (!row.summary) return { ...row, cpu }
      const { frames, ...summary } = row.summary
      const distribution = new Map()
      for (const frame of frames) {
        const key = JSON.stringify([frame.terminal, frame.counts])
        const entry = distribution.get(key) ?? {
          terminal: frame.terminal,
          counts: frame.counts,
          samples: 0,
        }
        entry.samples++
        distribution.set(key, entry)
      }
      return {
        ...row,
        cpu,
        summary: { ...summary, frameCounterDistribution: [...distribution.values()] },
      }
    }),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = analysisArguments(process.argv.slice(2))
  const result = await analyze(resolve(options.input))
  const text = JSON.stringify(options.compact ? compactAnalysis(result) : result, null, 2) + '\n'
  if (options.output) await writeFile(resolve(options.output), text)
  else process.stdout.write(text)
}

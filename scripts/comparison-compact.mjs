import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { join, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pairedRatios, quantile } from './comparison-report.mjs'

export function comparisonLatencyEndpoint({ tracing, headless, platform }) {
  if (tracing) return 'keydown/write to first screencast PNG containing the intended colored glyph'
  if (platform === 'linux' && headless)
    return 'keydown/write to compositor presentation ack (headless-shell, on-demand, not vsync)'
  return 'keydown/write to Chrome presentation feedback (terminal rendered frame)'
}

function cpu(value) {
  if (!value) return undefined
  const {
    milliseconds,
    secondsByType,
    percentOfOneCore,
    acquisitionUncertaintyMilliseconds,
    tickSeconds,
  } = value
  return {
    milliseconds,
    secondsByType,
    percentOfOneCore,
    acquisitionUncertaintyMilliseconds,
    tickSeconds,
  }
}
function gpu(value) {
  if (!value) return undefined
  const readings = value.samples ?? []
  const range = readings.length
    ? [
        Math.min(...readings.map((sample) => sample.utilizationPercent)),
        Math.max(0, ...readings.map((sample) => sample.utilizationPercent)),
      ]
    : null
  return {
    status: value.status,
    qualified: value.qualified,
    skipReason: value.skipReason,
    settings: value.settings,
    baselineForeignComputePids: value.baselineForeignComputePids,
    newForeignComputePids: value.newForeignComputePids,
    sampleCount: readings.length,
    waitMilliseconds: value.waitMilliseconds,
    utilizationPercent: range,
    maxForeignComputeMemoryMiB: Math.max(0, ...readings.map((sample) => sample.computeMemoryMiB)),
    maxOwnedComputeMemoryMiB: Math.max(
      0,
      ...readings.map((sample) =>
        sample.processes
          .filter((entry) => entry.allowed)
          .reduce((sum, entry) => sum + entry.memoryMiB, 0),
      ),
    ),
  }
}
async function timeline(run, directory) {
  const presentations = run.latency.presentations.filter((entry) => entry.operation === 'input')
  const p50 = quantile(run.latency.input, 0.5)
  const selected = presentations.toSorted(
    (a, b) => Math.abs(a.milliseconds - p50) - Math.abs(b.milliseconds - p50),
  )[0]
  const trace = JSON.parse(
    gunzipSync(await readFile(join(directory, run.latency.trace))).toString(),
  )
  const ack = trace.traceEvents.find(
    (event) =>
      event.name === 'AnimationFrame::Presentation' && event.args?.id === selected.animationId,
  )
  assert(ack)
  const offset = ack.ts / 1000 - selected.milliseconds
  const events = trace.traceEvents
    .filter((event) => {
      const relative = event.ts / 1000 - offset
      return (
        event.pid === ack.pid &&
        relative >= -0.05 &&
        relative <= selected.milliseconds &&
        (/^compare\/(keydown|echo-sent|echo-received|0\/parse\/|0\/js\/(drawFrame|renderRows|render)|0\/commands\/)/.test(
          event.name,
        ) ||
          event.name === 'AnimationFrame::Presentation')
      )
    })
    .map((event) => ({ name: event.name, phase: event.ph, milliseconds: event.ts / 1000 - offset }))
  return {
    variant: run.variant,
    repetition: run.repetition,
    selection: 'input sample nearest per-run p50',
    trace: run.latency.trace,
    animationId: selected.animationId,
    endpointMilliseconds: selected.milliseconds,
    parseEndMilliseconds: selected.parseEnd,
    renderBoundary: selected.renderBoundary,
    renderBoundaryEndMilliseconds: selected.renderBoundaryEnd,
    events,
  }
}
export async function compactEvidence(artifact, directory) {
  const compact = {
    schema: 1,
    sessionId: artifact.sessionId,
    startedAt: artifact.startedAt,
    finishedAt: artifact.finishedAt,
    counts: artifact.counts,
    paths: artifact.paths,
    variants: artifact.variants,
    phases: artifact.phases,
    frameBuilders: artifact.frameBuilders,
    fixtures: artifact.fixtures,
    repetitions: artifact.repetitions,
    latencySamples: artifact.latencySamples,
    outputFrames: artifact.outputFrames,
    outputFixture: artifact.outputFixture,
    cpuTickSeconds: artifact.cpuTickSeconds,
    hardware: artifact.hardware,
    manifest: {
      commit: artifact.manifest.commit,
      builder: artifact.manifest.builder,
      sourceInventoryHashFormat: artifact.manifest.sourceInventoryHashFormat,
      dirty: artifact.manifest.dirty,
      sourceSha256: artifact.manifest.sourceSha256,
      sourceHashFormat: artifact.manifest.sourceHashFormat,
      runtime: artifact.manifest.runtime,
      benchmark: artifact.manifest.benchmark,
      fixtures: artifact.manifest.fixtures,
      bundleSha256: artifact.manifest.bundleSha256,
      assets: artifact.manifest.assets,
      versions: artifact.manifest.versions,
      settings: artifact.manifest.settings,
    },
    environment: {
      browser: artifact.environment.browser,
      browserChannel: artifact.environment.browserChannel,
      os: artifact.environment.os,
      cpu: artifact.environment.cpu,
      renderer: artifact.environment.renderer,
      headless: artifact.environment.headless,
      latencyEndpoint: artifact.environment.latencyEndpoint,
      launchArguments: artifact.environment.launchArguments,
      gpuIdleSettings: artifact.environment.gpuIdleSettings,
      gpuDevices: artifact.environment.gpu.gpu.devices,
      gpuFeatureStatus: artifact.environment.gpu.gpu.featureStatus,
    },
    limitations: [
      'Compositor acknowledgement is on-demand; physical-vsync and optical display latency are unmeasured.',
      'GPU-process CPU is CPU consumption, not GPU hardware execution time.',
      'NVIDIA total utilization includes benchmark load; foreign compute residency is a conservative activity proxy, and sampling can miss short bursts.',
      'CPU verdicts require at least the configured minimum ticks per side and a difference exceeding one tick; idle and zero/zero can remain unresolved.',
      'Tracing instrumentation is loaded in every hardware run, including CPU and burst windows; inactive wrapper call counts differ by renderer.',
    ],
    qualifications: artifact.qualifications,
    runs: artifact.runs.map((run) => ({
      variant: run.variant,
      frameBuilder: run.frameBuilder,
      path: run.path,
      count: run.count,
      repetition: run.repetition,
      pairId: run.pairId,
      sessionId: run.sessionId,
      executionOrder: run.executionOrder,
      status: run.status,
      error: run.error,
      pageErrors: run.pageErrors,
      gpuIdle: run.gpuIdle,
      adapter: run.info?.adapter,
      refreshPeriod: run.refreshPeriod,
      idle: run.idle ? { cpu: cpu(run.idle.cpu) } : undefined,
      output: run.output
        ? {
            fixture: run.output.fixture,
            input: run.output.input,
            bytes: run.output.bytes,
            frameMetrics: run.output.frameMetrics,
            chunkCount: run.output.chunkCount,
            reset: run.output.reset,
            completedCycles: run.output.completedCycles,
            nextChunk: run.output.nextChunk,
            cpu: cpu(run.output.cpu),
          }
        : undefined,
      latency: run.latency
        ? {
            endpoint: run.latency.endpoint,
            trace: run.latency.trace,
            input: run.latency.input,
            write: run.latency.write,
          }
        : undefined,
      presentationValidation: run.presentationValidation
        ? {
            samples: run.presentationValidation.write.length,
            delayFrames: 1,
            ordinaryWriteP50: quantile(run.latency.write, 0.5),
            delayedWriteP50: quantile(run.presentationValidation.write, 0.5),
            differenceMilliseconds:
              quantile(run.presentationValidation.write, 0.5) - quantile(run.latency.write, 0.5),
            trace: run.presentationValidation.trace,
          }
        : undefined,
      gpuWindows: (run.gpuWindows ?? []).map((entry) => ({
        label: entry.label,
        idle: gpu(entry.idle),
        window: gpu(entry.window),
        failure: entry.failure,
      })),
    })),
    representativeInputTimelines: directory
      ? await Promise.all(
          artifact.runs
            .filter(
              (run) =>
                !run.error &&
                run.latency?.presentations?.length &&
                run.repetition === 0 &&
                run.count === 1,
            )
            .map((run) => timeline(run, directory)),
        )
      : undefined,
    pairedRatios: pairedRatios(artifact),
  }
  assert.deepEqual(pairedRatios(compact), compact.pairedRatios)
  return compact
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output] = process.argv.slice(2)
  assert(input && output, 'Usage: node comparison-compact.mjs <comparison.json> <compact.json>')
  const artifact = JSON.parse(await readFile(input, 'utf8'))
  assert(artifact.finishedAt && !artifact.error, 'A finished benchmark artifact is required')
  const compact = await compactEvidence(artifact, dirname(input))
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(compact, null, 2) + '\n')
  for (const row of compact.pairedRatios) console.log(row.count, row.metric, row.median, row.status)
}

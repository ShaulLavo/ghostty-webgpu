import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const execute = promisify(execFile)

export class GpuQualificationError extends Error {
  constructor(reason, evidence) {
    super(reason)
    this.name = 'GpuQualificationError'
    this.evidence = evidence
  }
}

function number(value) {
  assert(/^\d+(?:\.\d+)?$/.test(value.trim()), 'NVIDIA sample requires a numeric value')
  return Number(value)
}

const lines = (output) => output.trim().split(/\r?\n/).filter(Boolean)

function parseGpus(output) {
  const gpus = lines(output).map((line) => {
    const fields = line.split(',').map((value) => value.trim())
    assert.equal(fields.length, 2, 'NVIDIA GPU sample requires UUID and utilization')
    const utilizationPercent = number(fields[1])
    assert(utilizationPercent <= 100, 'NVIDIA utilization must be a percentage')
    return { uuid: fields[0], utilizationPercent }
  })
  assert(gpus.length > 0, 'NVIDIA sample requires at least one GPU')
  assert.equal(new Set(gpus.map((gpu) => gpu.uuid)).size, gpus.length, 'Duplicate NVIDIA GPU UUID')
  return gpus
}

function parseProcesses(output, allowedComputePids) {
  const allowed = new Set(allowedComputePids)
  return lines(output).map((line) => {
    const fields = line.split(',').map((value) => value.trim())
    assert.equal(fields.length, 3, 'NVIDIA process sample requires UUID, PID and memory')
    const pid = number(fields[1])
    assert(Number.isInteger(pid) && pid > 0, 'NVIDIA sample requires a positive process ID')
    return {
      uuid: fields[0],
      pid,
      memoryMiB: number(fields[2]),
      allowed: allowed.has(pid),
    }
  })
}

export function parseGpuSample(gpuOutput, computeOutput, allowedComputePids = []) {
  const gpus = parseGpus(gpuOutput)
  const processes = parseProcesses(computeOutput, allowedComputePids)
  for (const process of processes) {
    assert(
      gpus.some((gpu) => gpu.uuid === process.uuid),
      'NVIDIA process GPU must be present',
    )
  }
  return {
    gpus,
    processes,
    utilizationPercent: Math.max(...gpus.map((gpu) => gpu.utilizationPercent)),
    computeMemoryMiB: processes
      .filter((entry) => !entry.allowed)
      .reduce((total, entry) => total + entry.memoryMiB, 0),
  }
}

function isTimeout(error) {
  return (
    error.code === 'ETIMEDOUT' ||
    (error.code == null && error.killed && ['SIGTERM', 'SIGKILL'].includes(error.signal))
  )
}

async function sampleCommand(command, args, options, receipt, now) {
  let timer
  let pending
  let expired = false
  const captureStdout = (chunk) => {
    receipt.stdout += chunk.toString()
  }
  const captureStderr = (chunk) => {
    receipt.stderr += chunk.toString()
  }
  try {
    pending = command('nvidia-smi', args, options)
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        expired = true
        receipt.requestedSignal = pending.child ? 'SIGKILL' : null
        pending.child?.kill('SIGKILL')
        reject(
          Object.assign(new GpuQualificationError('NVIDIA command deadline expired', null), {
            code: 'ETIMEDOUT',
            signal: pending.child?.signalCode ?? null,
            killed: Boolean(pending.child?.killed),
            stdout: receipt.stdout,
            stderr: receipt.stderr,
          }),
        )
      }, options.timeout)
    })
    pending.child?.stdout?.on('data', captureStdout)
    pending.child?.stderr?.on('data', captureStderr)
    const output = await Promise.race([pending, deadline])
    Object.assign(receipt, {
      code: output.code ?? pending.child?.exitCode ?? 0,
      signal: output.signal ?? pending.child?.signalCode ?? null,
      killed: Boolean(output.killed || pending.child?.killed),
      stdout: output.stdout,
      stderr: output.stderr ?? '',
    })
    if (receipt.killed || receipt.signal || receipt.code !== 0) {
      throw Object.assign(new GpuQualificationError('NVIDIA command terminated', null), {
        ...receipt,
        code: receipt.killed ? 'ETIMEDOUT' : receipt.code,
      })
    }
    return output
  } catch (error) {
    Object.assign(receipt, {
      code: error.code ?? null,
      signal: error.signal ?? null,
      killed: Boolean(error.killed || pending?.child?.killed),
      stdout: error.stdout ?? receipt.stdout,
      stderr: error.stderr ?? receipt.stderr,
      deadlineExpired: expired,
    })
    throw error
  } finally {
    clearTimeout(timer)
    pending?.child?.stdout?.off('data', captureStdout)
    pending?.child?.stderr?.off('data', captureStderr)
    receipt.processPending = Boolean(
      pending?.child && pending.child.exitCode === null && pending.child.signalCode === null,
    )
    receipt.exitCode = pending?.child?.exitCode ?? null
    receipt.signalCode = pending?.child?.signalCode ?? null
    receipt.completed = now()
  }
}

export async function sampleNvidiaGpu({
  command = execute,
  timeoutMilliseconds,
  allowedComputePids = [],
  now = () => performance.now(),
} = {}) {
  assert(
    Number.isFinite(timeoutMilliseconds) && timeoutMilliseconds > 0,
    'Positive NVIDIA command timeout required',
  )
  const started = now()
  // Hard termination avoids an exit-zero SIGTERM handler concealing a command timeout.
  const options = {
    timeout: Math.max(1, Math.ceil(timeoutMilliseconds)),
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
  }
  const commands = []
  const queries = [
    ['--query-gpu=uuid,utilization.gpu', '--format=csv,noheader,nounits'],
    ['--query-compute-apps=gpu_uuid,pid,used_gpu_memory', '--format=csv,noheader,nounits'],
  ]
  const results = await Promise.allSettled(
    queries.map(async (args) => {
      const receipt = {
        binary: 'nvidia-smi',
        args,
        started: now(),
        observedAt: new Date().toISOString(),
        stdout: '',
        stderr: '',
      }
      commands.push(receipt)
      return sampleCommand(command, args, options, receipt, now)
    }),
  )
  try {
    const failures = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason)
    for (const [index, result] of results.entries()) {
      if (result.status !== 'fulfilled' || failures.length === 0) continue
      try {
        if (index === 0) parseGpus(result.value.stdout)
        if (index === 1) parseProcesses(result.value.stdout, allowedComputePids)
      } catch (error) {
        failures.push(error)
      }
    }
    const failed = failures.find((error) => !isTimeout(error)) ?? failures[0]
    if (failed) {
      failed.samplingFailures = failures.map(
        ({ name, code, message, killed, signal, stdout, stderr }) => ({
          name,
          code,
          message,
          killed,
          signal,
          stdout,
          stderr,
        }),
      )
      throw failed
    }
    const [gpu, compute] = results.map((result) => result.value)
    return {
      ...parseGpuSample(gpu.stdout, compute.stdout, allowedComputePids),
      started,
      completed: now(),
    }
  } catch (error) {
    // A driver command can exit successfully with empty output; retain its evidence on parse failure.
    error.samplingCommands = commands
    throw error
  }
}

function validateSettings(settings) {
  for (const key of [
    'gpuSampleMilliseconds',
    'gpuIdleWaitMilliseconds',
    'gpuCommandTimeoutMilliseconds',
  ]) {
    assert(Number.isFinite(settings[key]) && settings[key] > 0, `Positive ${key} required`)
  }
  assert(
    Number.isInteger(settings.gpuIdleConsecutiveSamples) && settings.gpuIdleConsecutiveSamples > 0,
    'Positive gpuIdleConsecutiveSamples required',
  )
  assert(
    Number.isFinite(settings.gpuIdleUtilizationPercent) &&
      settings.gpuIdleUtilizationPercent >= 0 &&
      settings.gpuIdleUtilizationPercent <= 100,
    'gpuIdleUtilizationPercent must be between zero and 100',
  )
  assert(
    Number.isFinite(settings.gpuWindowUtilizationPercent) &&
      settings.gpuWindowUtilizationPercent >= 0 &&
      settings.gpuWindowUtilizationPercent <= 100,
    'gpuWindowUtilizationPercent must be between zero and 100',
  )
  assert(
    Number.isFinite(settings.gpuComputeMemoryMiB) && settings.gpuComputeMemoryMiB >= 0,
    'Nonnegative gpuComputeMemoryMiB required',
  )
}

export function createGpuGate(
  settings,
  {
    platform = process.platform,
    command = execute,
    allowedComputePids = [],
    now = () => performance.now(),
    sleep = delay,
    sample = (timeoutMilliseconds) =>
      sampleNvidiaGpu({
        command,
        allowedComputePids,
        now,
        timeoutMilliseconds,
      }),
  } = {},
) {
  validateSettings(settings)
  let skipReason = platform === 'linux' ? null : 'NVIDIA qualification is available on Linux'
  let sampledSuccessfully = false
  let idleBaseline = null

  async function acquire(
    evidence,
    timeoutMilliseconds = settings.gpuCommandTimeoutMilliseconds,
    retryTimeout = false,
  ) {
    try {
      const reading = await sample(timeoutMilliseconds)
      evidence.samples.push(reading)
      sampledSuccessfully = true
      return reading
    } catch (error) {
      const failures = error.samplingFailures ?? [error]
      const noDevices = failures.every((failure) =>
        /no devices were found|no devices found/i.test(failure.stdout ?? ''),
      )
      const unavailable = failures.every((failure) => failure.code === 'ENOENT')
      const allQueriesFailed =
        !error.samplingCommands || failures.length === error.samplingCommands.length
      if (!sampledSuccessfully && allQueriesFailed && (unavailable || noDevices)) {
        skipReason = noDevices ? 'No NVIDIA GPU devices found' : 'nvidia-smi is unavailable'
        evidence.status = 'skipped'
        evidence.qualified = true
        evidence.skipReason = skipReason
        return null
      }
      const samplingError = {
        name: error.name,
        code: error.code ?? null,
        message: error.message,
        commands: error.samplingCommands,
        failures: error.samplingFailures,
      }
      const timedOut = failures.every(isTimeout)
      if (retryTimeout && timedOut) {
        evidence.samplingTimeouts ??= []
        evidence.samplingTimeouts.push(samplingError)
        return undefined
      }
      evidence.status = 'failed'
      evidence.reason = 'NVIDIA GPU sampling failed'
      evidence.samplingError = samplingError
      throw new GpuQualificationError(evidence.reason, evidence)
    }
  }

  function evidence(kind) {
    return {
      kind,
      foreignActivityMetric: 'resident-compute-memory-mib',
      limitation:
        'Resident memory is a conservative proxy for foreign compute activity; utilization includes the benchmark. Sampling can miss bursts shorter than the sample interval.',
      status: skipReason ? 'skipped' : 'sampling',
      qualified: Boolean(skipReason),
      skipReason,
      settings: {
        gpuIdleUtilizationPercent: settings.gpuIdleUtilizationPercent,
        gpuWindowUtilizationPercent: settings.gpuWindowUtilizationPercent,
        gpuComputeMemoryMiB: settings.gpuComputeMemoryMiB,
        gpuSampleMilliseconds: settings.gpuSampleMilliseconds,
        gpuIdleConsecutiveSamples: settings.gpuIdleConsecutiveSamples,
        gpuIdleWaitMilliseconds: settings.gpuIdleWaitMilliseconds,
        gpuCommandTimeoutMilliseconds: settings.gpuCommandTimeoutMilliseconds,
      },
      samples: [],
    }
  }

  async function waitForIdle() {
    const result = evidence('idle')
    if (skipReason) return result
    const started = now()
    idleBaseline = null
    let consecutive = 0
    while (now() - started < settings.gpuIdleWaitMilliseconds) {
      const remaining = settings.gpuIdleWaitMilliseconds - (now() - started)
      const reading = await acquire(
        result,
        Math.min(remaining, settings.gpuCommandTimeoutMilliseconds),
        true,
      )
      if (reading === null) return result
      const idle =
        reading !== undefined &&
        reading.utilizationPercent <= settings.gpuIdleUtilizationPercent &&
        reading.computeMemoryMiB <= settings.gpuComputeMemoryMiB
      consecutive = idle ? consecutive + 1 : 0
      result.waitMilliseconds = now() - started
      if (
        consecutive >= settings.gpuIdleConsecutiveSamples &&
        result.waitMilliseconds <= settings.gpuIdleWaitMilliseconds
      ) {
        idleBaseline = reading
        result.status = 'qualified'
        result.qualified = true
        return result
      }
      const pause = Math.min(
        settings.gpuSampleMilliseconds,
        settings.gpuIdleWaitMilliseconds - (now() - started),
      )
      if (pause > 0) await sleep(pause)
    }
    result.status = 'failed'
    result.reason = 'NVIDIA GPU idle wait expired'
    if (result.samplingTimeouts?.length) result.samplingError = result.samplingTimeouts.at(-1)
    result.waitMilliseconds = now() - started
    throw new GpuQualificationError(result.reason, result)
  }

  async function monitorWindow(
    operation,
    { sampleMilliseconds = settings.gpuSampleMilliseconds } = {},
  ) {
    assert(
      Number.isFinite(sampleMilliseconds) && sampleMilliseconds > 0,
      'Positive sampleMilliseconds required',
    )
    const result = evidence('window')
    result.settings.gpuSampleMilliseconds = sampleMilliseconds
    if (skipReason) return { value: await operation(), gpu: result }
    const first = await acquire(result)
    if (!first) return { value: await operation(), gpu: result }
    const baseline = idleBaseline ?? first
    const foreignPids = new Set(
      baseline.processes.filter((entry) => !entry.allowed).map((entry) => entry.pid),
    )
    result.baselineForeignComputePids = [...foreignPids]
    assertCompute(first, result, foreignPids)
    let stopped = false
    const controller = new AbortController()
    // Attach the rejection handler before running the window so sampler failures are retained.
    const monitoring = monitor(
      result,
      () => stopped,
      controller.signal,
      foreignPids,
      sampleMilliseconds,
    ).catch((error) => error)
    let value
    let operationFailure
    let monitoringFailure
    try {
      value = await operation()
    } catch (error) {
      operationFailure = { error }
    } finally {
      stopped = true
      controller.abort()
      monitoringFailure = await monitoring
    }
    if (monitoringFailure) throw monitoringFailure
    if (operationFailure) throw operationFailure.error
    const last = await acquire(result)
    if (last) assertCompute(last, result, foreignPids)
    if (result.status !== 'skipped') result.status = 'qualified'
    result.qualified = true
    return { value, gpu: result }
  }

  function assertCompute(reading, result, foreignPids) {
    const busy = reading.utilizationPercent > settings.gpuWindowUtilizationPercent
    const newForeignPids = reading.processes
      .filter((entry) => !entry.allowed && !foreignPids.has(entry.pid))
      .map((entry) => entry.pid)
    const foreign =
      reading.computeMemoryMiB > settings.gpuComputeMemoryMiB || newForeignPids.length > 0
    if (newForeignPids.length > 0) result.newForeignComputePids = [...new Set(newForeignPids)]
    if (!busy && !foreign) return
    result.status = 'failed'
    result.qualified = false
    result.reason = busy
      ? 'NVIDIA GPU utilization exceeded the measurement threshold'
      : 'External NVIDIA compute activity detected during measurement'
    throw new GpuQualificationError(result.reason, result)
  }

  async function monitor(result, stopped, signal, foreignPids, sampleMilliseconds) {
    while (!stopped()) {
      try {
        await sleep(sampleMilliseconds, undefined, { signal })
      } catch (error) {
        if (signal.aborted) return
        throw error
      }
      if (stopped()) return
      const reading = await acquire(result)
      if (!reading) return
      assertCompute(reading, result, foreignPids)
    }
  }

  return { waitForIdle, monitorWindow }
}

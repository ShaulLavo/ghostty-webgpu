import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const macFields = {
  identity: 'ri_proc_start_abstime',
  exit: 'ri_proc_exit_abstime',
  userTimeNs: 'ri_user_time',
  systemTimeNs: 'ri_system_time',
  pUserTimeNs: 'ri_user_ptime',
  pSystemTimeNs: 'ri_system_ptime',
  instructions: 'ri_instructions',
  cycles: 'ri_cycles',
  pInstructions: 'ri_pinstructions',
  pCycles: 'ri_pcycles',
  energyNj: 'ri_energy_nj',
  pEnergyNj: 'ri_penergy_nj',
}

const fieldCapabilities = {
  pCoreSeconds: 'pCoreSeconds',
  pUserTimeNs: 'pCoreSeconds',
  pSystemTimeNs: 'pCoreSeconds',
  instructions: 'instructions',
  cycles: 'cycles',
  pInstructions: 'pInstructions',
  pCycles: 'pCycles',
  energyNj: 'energyJ',
  pEnergyNj: 'pEnergyJ',
}

function available(metadata, field) {
  const name = fieldCapabilities[field]
  return !name || metadata.capabilities?.[name]?.available === true
}

function parseMac(values, metadata) {
  return Object.fromEntries(
    Object.entries(macFields).map(([name, field]) => [
      name,
      available(metadata, name) ? integer(values[field], field) : null,
    ]),
  )
}

function integer(value, name) {
  assert(
    typeof value === 'string' && /^\d+$/.test(value),
    `${name} requires an unsigned decimal integer string`,
  )
  return BigInt(value)
}

function parsePmu(events, pmu) {
  const parsed = {}
  for (const name of ['instructions', 'cycles']) {
    assert(
      Array.isArray(events[name]) && events[name].length,
      `${pmu}/${name} requires thread counters`,
    )
    parsed[name] = events[name].map((entry) => ({
      tid: entry.tid,
      value: integer(entry.value, name),
      enabledNs: integer(entry.enabledNs, 'enabledNs'),
      runningNs: integer(entry.runningNs, 'runningNs'),
    }))
  }
  return parsed
}

function parsePerf(values) {
  const pmus = Object.fromEntries(
    Object.entries(values.pmus).map(([pmu, events]) => [pmu, parsePmu(events, pmu)]),
  )
  assert(Object.keys(pmus).length, 'At least one PMU required')
  return {
    identity: integer(values.identity, 'identity'),
    userTimeNs: integer(values.userTimeNs, 'userTimeNs'),
    systemTimeNs: integer(values.systemTimeNs, 'systemTimeNs'),
    pmus,
  }
}

export function parseCounterSnapshot(raw, metadata) {
  assert(
    ['proc_pid_rusage/RUSAGE_INFO_V6', 'perf_event_open'].includes(metadata.source),
    'Known counter source required',
  )
  const requestedNs = integer(raw.requestedNs, 'requestedNs')
  const completedNs = integer(raw.completedNs, 'completedNs')
  assert(completedNs >= requestedNs, 'Ordered snapshot acquisition timestamps required')
  const processes = new Map()
  for (const [pid, entry] of Object.entries(raw.processes)) {
    assert(Number.isSafeInteger(Number(pid)) && Number(pid) > 0, 'Positive integer PID required')
    const { values } = entry
    const times = {
      requestedNs: integer(entry.requestedNs, 'requestedNs'),
      completedNs: integer(entry.completedNs, 'completedNs'),
    }
    assert(
      times.completedNs >= times.requestedNs,
      'Ordered process acquisition timestamps required',
    )
    assert(
      times.requestedNs >= requestedNs && times.completedNs <= completedNs,
      'Snapshot timestamps must enclose each process read',
    )
    if (values.error !== undefined) {
      processes.set(Number(pid), { ...times, error: values.reason ?? String(values.error) })
      continue
    }
    const counters =
      metadata.source === 'perf_event_open' ? parsePerf(values) : parseMac(values, metadata)
    processes.set(Number(pid), { ...times, ...counters })
  }
  return {
    requestedNs,
    completedNs,
    processes,
    metadata,
  }
}

function difference(before, after, name) {
  const amount = after - before
  assert(
    amount >= 0n && amount <= BigInt(Number.MAX_SAFE_INTEGER),
    `${name} delta regressed or exceeds exact numeric range`,
  )
  return Number(amount)
}

function addCount(left, right, name) {
  const value = left + right
  assert(Number.isSafeInteger(value), `${name} aggregate exceeds exact numeric range`)
  return value
}

function pmuDelta(before, after) {
  const result = {}
  for (const name of ['instructions', 'cycles']) {
    const previous = before[name]
    assert.deepEqual(
      previous.map((row) => row.tid),
      after[name].map((row) => row.tid),
      'Attached thread counter set changed',
    )
    result[name] = 0
    result[`${name}Coverage`] = after[name].map((entry, index) => {
      const old = previous[index]
      const value = difference(old.value, entry.value, name)
      const enabledNs = difference(old.enabledNs, entry.enabledNs, 'enabledNs')
      const runningNs = difference(old.runningNs, entry.runningNs, 'runningNs')
      assert(runningNs <= enabledNs, 'Perf running time exceeds enabled time')
      assert(value === 0 || runningNs > 0, 'Nonzero perf count requires running time')
      result[name] = addCount(result[name], value, name)
      return { tid: entry.tid, enabledNs, runningNs }
    })
  }
  return result
}

function scheduling(pmus, name) {
  const threads = new Map()
  for (const pmu of Object.values(pmus)) {
    for (const row of pmu[`${name}Coverage`]) {
      const old = threads.get(row.tid) ?? { enabledNs: 0, runningNs: 0 }
      threads.set(row.tid, {
        enabledNs: Math.max(old.enabledNs, row.enabledNs),
        runningNs: addCount(old.runningNs, row.runningNs, 'runningNs'),
      })
    }
  }
  return [...threads.values()]
}

function perfDelta(before, after, cpuSeconds) {
  assert.deepEqual(Object.keys(before.pmus), Object.keys(after.pmus), 'PMU set changed')
  const pmus = Object.fromEntries(
    Object.entries(after.pmus).map(([pmu, events]) => [pmu, pmuDelta(before.pmus[pmu], events)]),
  )
  const counts = Object.fromEntries(
    ['instructions', 'cycles'].map((name) => [
      name,
      Object.values(pmus).reduce((sum, row) => addCount(sum, row[name], name), 0),
    ]),
  )
  const active = cpuSeconds > 0 || counts.instructions > 0 || counts.cycles > 0
  const unavailable = ['instructions', 'cycles'].filter(
    (name) => active && !scheduling(pmus, name).some((row) => row.runningNs > 0),
  )
  const clockAvailable = scheduling(pmus, 'cycles').every((row) => row.runningNs >= row.enabledNs)
  return {
    ...counts,
    pmus,
    clockAvailable,
    ...(unavailable.length
      ? {
          coverageError: `${unavailable.join(' and ')} events never scheduled during active user CPU`,
          instructions: null,
          cycles: null,
        }
      : {}),
  }
}

function clusterMetrics({ instructions, cycles, pInstructions = null, pCycles = null }) {
  const remainder = (total, part, name) => {
    if (total === null || part === null) return null
    assert(part <= total, `P-core ${name} exceeds total ${name}`)
    return total - part
  }
  const ratio = (numerator, denominator) =>
    numerator !== null && denominator > 0 ? numerator / denominator : null
  const eInstructions = remainder(instructions, pInstructions, 'instructions')
  const eCycles = remainder(cycles, pCycles, 'cycles')
  return {
    eInstructions,
    eCycles,
    ipc: ratio(instructions, cycles),
    pIPC: ratio(pInstructions, pCycles),
    eIPC: ratio(eInstructions, eCycles),
    pInstructionShare: ratio(pInstructions, instructions),
    pCycleShare: ratio(pCycles, cycles),
  }
}

function processDelta(before, after, metadata) {
  assert(before.identity === after.identity, 'PID start identity changed')
  assert(!after.exit, 'Process exited during the window')
  const userNs = difference(before.userTimeNs, after.userTimeNs, 'userTimeNs')
  const systemNs = difference(before.systemTimeNs, after.systemTimeNs, 'systemTimeNs')
  const userSeconds = userNs / 1e9
  const systemSeconds = systemNs / 1e9
  const linux = metadata.source === 'perf_event_open'
  const result = {
    cpuSeconds: linux ? userSeconds : userSeconds + systemSeconds,
    userSeconds,
    systemSeconds,
  }
  if (linux) return { ...result, ...perfDelta(before, after, result.cpuSeconds) }
  for (const field of [
    'instructions',
    'cycles',
    'pInstructions',
    'pCycles',
    'energyNj',
    'pEnergyNj',
  ])
    result[field] = available(metadata, field)
      ? difference(before[field], after[field], field)
      : null
  const pCoreNs = available(metadata, 'pUserTimeNs')
    ? difference(before.pUserTimeNs, after.pUserTimeNs, 'pUserTimeNs') +
      difference(before.pSystemTimeNs, after.pSystemTimeNs, 'pSystemTimeNs')
    : null
  result.pCoreSeconds = pCoreNs === null ? null : pCoreNs / 1e9
  // The reader floors each cumulative time from Mach ticks separately, so the two-field
  // P-core and total deltas can each be off by under 2 ns.
  assert(
    pCoreNs === null || pCoreNs - (userNs + systemNs) < 4,
    'P-core time exceeds total CPU time',
  )
  return { ...result, ...clusterMetrics(result) }
}

function channel(rows, metadata) {
  const mac = metadata.source === 'proc_pid_rusage/RUSAGE_INFO_V6'
  const sum = (field) => {
    if ((mac && !available(metadata, field)) || rows.some((row) => row[field] === null)) return null
    return rows.reduce(
      (total, row) =>
        field.endsWith('Seconds')
          ? total + (row[field] ?? 0)
          : addCount(total, row[field] ?? 0, field),
      0,
    )
  }
  const cpuSeconds = sum('cpuSeconds')
  const instructions = sum('instructions')
  const cycles = sum('cycles')
  const pCoreSeconds = mac ? sum('pCoreSeconds') : null
  const pInstructions = mac ? sum('pInstructions') : null
  const pCycles = mac ? sum('pCycles') : null
  const energyNj = mac ? sum('energyNj') : null
  const pEnergyNj = mac ? sum('pEnergyNj') : null
  const clockAvailable = rows.every((row) => row.clockAvailable !== false)
  return {
    instructions,
    cycles,
    cpuSeconds,
    pCoreSeconds,
    pInstructions,
    pCycles,
    ...(mac ? clusterMetrics({ instructions, cycles, pInstructions, pCycles }) : {}),
    pCoreShare: pCoreSeconds !== null && cpuSeconds > 0 ? pCoreSeconds / cpuSeconds : null,
    effectiveClockGHz:
      clockAvailable && cycles !== null && cpuSeconds > 0 ? cycles / cpuSeconds / 1e9 : null,
    effectivePClockGHz: pCycles !== null && pCoreSeconds > 0 ? pCycles / pCoreSeconds / 1e9 : null,
    energyJ: energyNj === null ? null : energyNj / 1e9,
    pEnergyJ: pEnergyNj === null ? null : pEnergyNj / 1e9,
    ...(!clockAvailable
      ? {
          clockReason:
            'Counter scheduling cannot separate residency from multiplexing for a full-CPU clock ratio',
        }
      : {}),
  }
}

function matchedProcess(pid, prior, final, first, last, metadata) {
  try {
    assert(prior.has(pid) && final.has(pid), 'CDP process appeared or disappeared')
    assert(prior.get(pid) === final.get(pid), 'CDP process type changed')
    assert(first && last, 'Native process snapshot missing')
    assert(!first.error && !last.error, first?.error ?? last?.error ?? 'Native read failed')
    return {
      pid,
      type: final.get(pid),
      identity: String(last.identity),
      ...processDelta(first, last, metadata),
    }
  } catch (error) {
    return { error: { pid, reason: error.message } }
  }
}

function unavailableChannels(metadata) {
  if (metadata.source !== 'proc_pid_rusage/RUSAGE_INFO_V6') {
    const energy = metadata.energyReason ?? 'Per-process energy is unavailable'
    const pTime = metadata.pCoreTimeReason ?? 'P-core CPU time is unavailable'
    return {
      energyJ: energy,
      pEnergyJ: energy,
      pCoreSeconds: pTime,
      pCoreShare: pTime,
      effectivePClockGHz: pTime,
    }
  }
  const entries = Array.from(new Set(Object.values(fieldCapabilities)), (name) => [
    name,
    metadata.capabilities?.[name],
  ])
  return Object.fromEntries(
    entries
      .filter(([, value]) => !value?.available)
      .map(([name, value]) => [
        name,
        value?.reason ?? `Native reader did not establish support for ${name}`,
      ]),
  )
}

export function counterDelta(before, after, cpuBefore, cpuAfter) {
  const prior = new Map(cpuBefore.map((row) => [row.id, row.type]))
  const final = new Map(cpuAfter.map((row) => [row.id, row.type]))
  const coverage = { matched: [], errors: [] }
  const processes = []
  for (const pid of new Set(Array.from(prior.keys()).concat(Array.from(final.keys())))) {
    const row = matchedProcess(
      pid,
      prior,
      final,
      before.processes.get(pid),
      after.processes.get(pid),
      before.metadata,
    )
    if (row.error) {
      coverage.errors.push(row.error)
      continue
    }
    processes.push(row)
    coverage.matched.push(pid)
    if (row.coverageError) coverage.errors.push({ pid, reason: row.coverageError })
  }
  const mac = before.metadata.source === 'proc_pid_rusage/RUSAGE_INFO_V6'
  const channels = {}
  if (!coverage.errors.length && processes.length) {
    channels.renderer = channel(
      processes.filter((row) => row.type === 'renderer'),
      before.metadata,
    )
    channels.GPU = channel(
      processes.filter((row) => row.type === 'GPU'),
      before.metadata,
    )
    channels.rendererPlusGPU = channel(
      processes.filter((row) => ['renderer', 'GPU'].includes(row.type)),
      before.metadata,
    )
    channels.otherChrome = channel(
      processes.filter((row) => !['renderer', 'GPU'].includes(row.type)),
      before.metadata,
    )
    channels.allChrome = channel(processes, before.metadata)
  }
  return {
    status: coverage.errors.length || !processes.length ? 'incomplete' : 'measured',
    source: before.metadata.source,
    scope: mac ? 'user and system CPU; all core classes' : 'user-space only',
    cpuTickNs: before.metadata.cpuTickNs ?? null,
    limitations: mac
      ? [
          'Kernel CPU energy estimate excludes GPU-device, display and non-Chrome power.',
          'Effective clock is a counter ratio.',
          'Total cycles combine core classes with different IPC and instruction placement.',
          'Endpoint snapshots cannot detect processes born and gone between endpoints.',
        ]
      : [
          'Hardware counts are raw and unscaled. PMU coverage records core residency and multiplexing together.',
          'Effective clock uses tick-quantized /proc user CPU time.',
          'P-core time and per-process energy are unavailable.',
          'Endpoint snapshots cannot detect processes born and gone between endpoints.',
        ],
    unavailable: unavailableChannels(before.metadata),
    processes,
    coverage,
    channels,
  }
}

export async function createCounterReader(
  session,
  { platform = process.platform, timeoutMilliseconds = 10000 } = {},
) {
  if (!['darwin', 'linux'].includes(platform))
    return { skipped: true, reason: `Native process counters are unavailable on ${platform}` }
  const executable = platform === 'darwin' ? '/usr/bin/python3' : 'python3'
  const script = platform === 'darwin' ? 'comparison-rusage.py' : 'comparison-perf.py'
  let child
  let lines
  let stderr = ''
  let failure
  async function reply() {
    let timer
    try {
      const line = await Promise.race([
        lines.next(),
        new Promise((resolve) => {
          timer = setTimeout(
            () => resolve({ done: true, reason: 'Process counter reader timed out' }),
            timeoutMilliseconds,
          )
        }),
      ])
      assert(
        !line.done && !failure,
        line.reason ?? failure?.message ?? (stderr || 'Process counter reader exited'),
      )
      return JSON.parse(line.value)
    } finally {
      clearTimeout(timer)
    }
  }
  async function request(value) {
    child.stdin.write(`${JSON.stringify(value)}\n`)
    return reply()
  }
  async function close() {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit')
    child.stdin.end()
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMilliseconds)
    try {
      await exited
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    const requested = performance.now()
    child = spawn(executable, [fileURLToPath(new URL(script, import.meta.url))], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
    child.stderr.on('data', (data) => {
      stderr = (stderr + data).slice(-2000)
    })
    child.on('error', (error) => {
      failure = error
    })
    child.stdin.on('error', (error) => {
      failure = error
    })
    const metadata = await reply()
    assert(metadata.ready, metadata.reason ?? 'Native reader unavailable')
    const { processInfo } = await session.send('SystemInfo.getProcessInfo')
    if (platform === 'linux') {
      const attached = await request({ command: 'start', pids: processInfo.map((row) => row.id) })
      metadata.attached = attached
    }
    return {
      metadata,
      initialProcessInfo: processInfo,
      setup: { requested, completed: performance.now() },
      snapshot: (processes) => request({ pids: processes.map((row) => row.id) }),
      close,
    }
  } catch (error) {
    await close()
    return { skipped: true, reason: error.message }
  }
}

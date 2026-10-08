import assert from 'node:assert/strict'

const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] ?? 0), 0)
const counterNames = [
  'ri_user_time',
  'ri_system_time',
  'ri_user_ptime',
  'ri_system_ptime',
  'ri_instructions',
  'ri_cycles',
  'ri_pinstructions',
  'ri_pcycles',
  'ri_energy_nj',
  'ri_penergy_nj',
  'ri_runnable_time',
  'ri_interrupt_wkups',
  'ri_pkg_idle_wkups',
]

export async function nativeSnapshot(browserSession, reader) {
  const requestedNs = process.hrtime.bigint().toString()
  const { processInfo } = await browserSession.send('SystemInfo.getProcessInfo')
  const cdpCompletedNs = process.hrtime.bigint().toString()
  const cpu = processInfo.map(({ id, type, cpuTime }) => ({ id, type, cpuTime }))
  const usage = await reader(cpu.map((row) => row.id))
  return {
    requestedNs,
    cdpCompletedNs,
    completedNs: process.hrtime.bigint().toString(),
    cpu,
    usage,
  }
}

export function nativeDelta(before, after) {
  const identity = (rows) => rows.map((row) => `${row.id}/${row.type}`).sort()
  assert.deepEqual(
    identity(before.cpu),
    identity(after.cpu),
    'CDP PID/type set changed inside window',
  )
  const perPid = []
  for (const process of after.cpu) {
    const pid = String(process.id)
    const old = before.usage.processes[pid]?.values
    const current = after.usage.processes[pid]?.values
    assert(
      old && current && !old.error && !current.error,
      `Native reader coverage missing for PID ${pid}`,
    )
    assert.equal(current.ri_proc_start_abstime, old.ri_proc_start_abstime, `PID ${pid} reused`)
    assert.equal(current.ri_proc_exit_abstime, '0', `PID ${pid} exited`)
    const delta = {}
    for (const key of counterNames) {
      const amount = BigInt(current[key]) - BigInt(old[key])
      assert(
        amount >= 0n && amount <= BigInt(Number.MAX_SAFE_INTEGER),
        `Invalid counter delta for ${pid}/${key}`,
      )
      delta[key] = Number(amount)
    }
    const prior = before.cpu.find((row) => row.id === process.id)
    perPid.push({
      pid: process.id,
      type: process.type,
      startAbstime: current.ri_proc_start_abstime,
      cdpCpuSeconds: process.cpuTime - prior.cpuTime,
      ...delta,
    })
  }
  const summarize = (rows) => {
    const values = Object.fromEntries(counterNames.map((key) => [key, sum(rows, key)]))
    const cpuSeconds = (values.ri_user_time + values.ri_system_time) / 1e9
    const pCpuSeconds = (values.ri_user_ptime + values.ri_system_ptime) / 1e9
    return {
      ...values,
      cpuSeconds,
      pCpuSeconds,
      cdpCpuSeconds: sum(rows, 'cdpCpuSeconds'),
      instructions: values.ri_instructions,
      cycles: values.ri_cycles,
      energyJ: values.ri_energy_nj / 1e9,
      effectiveClockGHz: cpuSeconds ? values.ri_cycles / cpuSeconds / 1e9 : null,
      pEffectiveClockGHz: pCpuSeconds ? values.ri_pcycles / pCpuSeconds / 1e9 : null,
      pCoreTimeShare: cpuSeconds ? pCpuSeconds / cpuSeconds : null,
    }
  }
  return {
    perPid,
    channels: {
      renderer: summarize(perPid.filter((row) => row.type === 'renderer')),
      GPU: summarize(perPid.filter((row) => row.type === 'GPU')),
      rendererPlusGPU: summarize(perPid.filter((row) => ['renderer', 'GPU'].includes(row.type))),
      allChrome: summarize(perPid),
      otherChrome: summarize(perPid.filter((row) => !['renderer', 'GPU'].includes(row.type))),
    },
    coverage:
      'Stable endpoint PID/type/start identities. Short-lived processes entirely between endpoints are outside this coverage. Sequential CDP and per-PID counter reads are non-atomic.',
  }
}

export function targetWork(measured) {
  return measured.after.map((row, index) => ({
    index,
    counters: Object.fromEntries(
      Object.entries(row.counters).map(([key, value]) => [
        key,
        value - (measured.before[index].counters[key] ?? 0),
      ]),
    ),
    metrics: Object.fromEntries(
      Object.entries(row.metrics)
        .filter(([, value]) => typeof value === 'number')
        .map(([key, value]) => [key, value - (measured.before[index].metrics[key] ?? 0)]),
    ),
    historyRows: row.historyRows,
    dirty: row.dirty,
    nativeSessionRevision: row.nativeSessionRevision,
    acceptedFrameSessionRevision: row.acceptedFrameSessionRevision,
    diagnostics: row.diagnostics,
    contextLost: row.contextLost,
  }))
}

export function assertWork(measured, count, ticks) {
  assert.equal(measured.stock.completedTicks, ticks)
  assert.equal(measured.before.length, count)
  assert.equal(measured.after.length, count)
  const targets = targetWork(measured)
  for (const row of targets) {
    assert.equal(row.counters.publicWrites, ticks + 1)
    assert.equal(row.counters.inputBytes, measured.stock.inputBytesPerTerminal + 19)
    assert(row.counters.rendererCallbacks > 0, 'Renderer callback work missing')
    assert(row.contextLost !== true, 'WebGL context lost')
    if (row.counters.actualCoreWrites === undefined) {
      assert.equal(row.counters.writeCallbacks, ticks + 1)
      assert(row.counters.actualParserCalls >= ticks + 1)
      continue
    }
    assert.equal(row.counters.actualCoreWrites, ticks + 1)
    assert.equal(row.dirty, 0, 'Native render state remains dirty at CPU boundary')
    assert.equal(
      row.nativeSessionRevision,
      row.acceptedFrameSessionRevision,
      'Native publication remains pending at CPU boundary',
    )
    assert.equal(row.metrics.deviceRestores ?? 0, 0, 'GPU device restored during measured window')
    assert.equal(row.diagnostics.hasPendingFrame, false)
    assert.equal(row.diagnostics.hasPendingTimer, false)
  }
  return targets
}

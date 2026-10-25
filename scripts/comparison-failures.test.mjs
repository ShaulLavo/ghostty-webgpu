import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gunzipSync } from 'node:zlib'
import { measureCpu } from './comparison-guards.mjs'
import { tracePhase } from './comparison-trace.mjs'

function syntheticCdp({ churn = false, stall, recorderFailure } = {}) {
  let time = 0
  let operated = false
  const calls = []
  const trace = '{"traceEvents":[{"name":"retained"}]}'
  const session = new EventEmitter()
  const requests = []
  session.send = async (name, parameters) => {
    calls.push(name)
    requests.push({ name, parameters })
    if (name === stall) return new Promise(() => {})
    if (name === 'SystemInfo.getProcessInfo') {
      const id = churn && operated ? 2 : 1
      const processInfo = [{ id, type: 'renderer', cpuTime: time / 1000 }]
      time += 10
      return { processInfo }
    }
    if (name === 'Tracing.end' && stall !== 'tracingComplete')
      session.emit('Tracing.tracingComplete', { stream: 'trace' })
    if (name === 'IO.read') return { data: trace, eof: true }
    return {}
  }
  const page = {
    async evaluate(callback) {
      const name = callback.toString().includes('traceBegin') ? 'record-begin' : 'record-end'
      calls.push(name)
      if (name === recorderFailure) assert.fail('Recorder failed')
      return { spans: [], counters: [], markers: [], ownership: [] }
    },
  }
  const sample = { completedWork: true }
  const operation = async () => {
    operated = true
    time += 100
    return sample
  }
  return { session, page, calls, requests, trace, sample, operation, now: () => time }
}

async function temporaryOutput(t, prefix) {
  const output = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(output, { recursive: true }))
  return output
}

const counterReader = () => ({
  skipped: true,
  reason: 'Synthetic reader',
  initialProcessInfo: [{ id: 1, type: 'renderer', cpuTime: 0 }],
  close: async () => {},
})

for (const counters of [false, true]) {
  const options = () => (counters ? { counterReader: counterReader() } : {})
  test(`${counters ? 'counter' : 'default'} CPU rejection retains boundaries, timestamps and completed work`, async () => {
    const cdp = syntheticCdp({ churn: true })
    await assert.rejects(
      measureCpu(cdp.session, cdp.operation, { ...options(), now: cdp.now }),
      (error) => {
        assert.match(error.message, /CPU process set changed during sample/)
        const cpu = error.cpuFailure
        assert.deepEqual(cpu.before, [{ id: 1, type: 'renderer', cpuTime: 0 }])
        assert.deepEqual(cpu.after, [{ id: 2, type: 'renderer', cpuTime: 0.11 }])
        assert.deepEqual(cpu.interval, {
          before: { requested: 0, completed: 10 },
          after: { requested: 110, completed: 120 },
        })
        assert.equal(cpu.milliseconds, 110)
        assert.equal(cpu.acquisitionUncertaintyMilliseconds, 10)
        assert.deepEqual(cpu.operation, { started: 10, completed: 110, sample: cdp.sample })
        assert.equal(cpu.percentOfOneCore, undefined)
        return true
      },
    )
  })
}

for (const churn of [false, true]) {
  test(`operation failure ${churn ? 'with CPU rejection' : 'with a stable process set'} retains its partial result and after snapshot`, async () => {
    const cdp = syntheticCdp({ churn })
    const failure = Object.assign(new TypeError('Operation failed'), {
      partialLatency: { completedSamples: 3 },
    })
    await assert.rejects(
      measureCpu(
        cdp.session,
        async () => {
          await cdp.operation()
          throw failure
        },
        { now: cdp.now },
      ),
      (error) => {
        assert.match(error.message, churn ? /CPU process set changed/ : /Operation failed/)
        if (!churn) assert.equal(error, failure)
        assert.equal(error.cpuFailure.after.length, 1)
        assert.deepEqual(error.cpuFailure.operation.sample, failure.partialLatency)
        assert.match(error.cpuFailure.operation.error, /TypeError: Operation failed/)
        return true
      },
    )
    assert.equal(cdp.calls.filter((name) => name === 'SystemInfo.getProcessInfo').length, 2)
  })
}

test('a failed traced CPU window saves the finalized trace and completed operation before rejection', async (t) => {
  const output = await temporaryOutput(t, 'comparison-failure-')
  const cdp = syntheticCdp({ churn: true })
  await assert.rejects(
    tracePhase({ ...cdp, browserSession: cdp.session, output, label: 'churn', traced: true }),
    (error) => {
      assert.match(error.message, /CPU process set changed/)
      assert.equal(error.phaseFailure.trace, 'churn.trace.json.gz')
      assert.deepEqual(error.phaseFailure.sample, cdp.sample)
      assert.deepEqual(error.phaseFailure.cpu.operation.sample, cdp.sample)
      return true
    },
  )
  assert.equal(
    gunzipSync(await readFile(join(output, 'churn.trace.json.gz'))).toString(),
    cdp.trace,
  )
  assert.deepEqual(cdp.calls.slice(-4), ['record-end', 'Tracing.end', 'IO.read', 'IO.close'])
  assert.equal(cdp.session.listenerCount('Tracing.tracingComplete'), 0)
})

test('a simultaneous phase operation error survives CPU rejection and trace finalization', async (t) => {
  const output = await temporaryOutput(t, 'comparison-phase-error-')
  const cdp = syntheticCdp({ churn: true })
  await assert.rejects(
    tracePhase({
      ...cdp,
      browserSession: cdp.session,
      output,
      label: 'operation',
      traced: true,
      operation: async () => {
        await cdp.operation()
        throw Object.assign(new TypeError('Endpoint failed'), { partialLatency: cdp.sample })
      },
    }),
    (error) => {
      assert.match(error.message, /CPU process set changed/)
      assert.match(error.phaseFailure.cpu.operation.error, /Endpoint failed/)
      assert.deepEqual(error.phaseFailure.sample, cdp.sample)
      return true
    },
  )
  assert.equal(
    gunzipSync(await readFile(join(output, 'operation.trace.json.gz'))).toString(),
    cdp.trace,
  )
})

for (const recorderFailure of ['record-begin', 'record-end']) {
  test(`${recorderFailure} failure still saves the finalized trace`, async (t) => {
    const output = await temporaryOutput(t, 'comparison-recorder-error-')
    const cdp = syntheticCdp({ recorderFailure })
    await assert.rejects(
      tracePhase({
        ...cdp,
        browserSession: cdp.session,
        output,
        label: 'recorder',
        traced: true,
      }),
      (error) => {
        assert.match(error.message, /Recorder failed/)
        assert.equal(error.phaseFailure.trace, 'recorder.trace.json.gz')
        return true
      },
    )
    assert.equal(
      gunzipSync(await readFile(join(output, 'recorder.trace.json.gz'))).toString(),
      cdp.trace,
    )
  })
}

for (const stall of ['Tracing.end', 'tracingComplete', 'IO.read', 'IO.close']) {
  test(
    `stalled ${stall} finalization is bounded and preserves the original CPU rejection`,
    { timeout: 1000 },
    async (t) => {
      const output = await temporaryOutput(t, 'comparison-finalizer-error-')
      const cdp = syntheticCdp({ churn: true, stall })
      t.after(() => cdp.session.emit('close'))
      await assert.rejects(
        tracePhase({
          ...cdp,
          browserSession: cdp.session,
          output,
          label: 'stalled',
          traced: true,
          finalizationMilliseconds: 10,
        }),
        (error) => {
          assert.match(error.message, /CPU process set changed/)
          assert.match(error.phaseFailure.finalizationError, /deadline exceeded/)
          assert.deepEqual(error.phaseFailure.sample, cdp.sample)
          return true
        },
      )
      if (stall === 'Tracing.end' || stall === 'tracingComplete')
        cdp.session.emit('Tracing.tracingComplete', { stream: 'late-stalled-stream' })
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(cdp.session.listenerCount('Tracing.tracingComplete'), 0)
      assert.equal(cdp.session.listenerCount('close'), 0)
      const files = await readdir(output)
      assert.deepEqual(files, stall === 'IO.close' ? ['stalled.trace.json.gz'] : [])
      if (stall === 'IO.close')
        assert.equal(gunzipSync(await readFile(join(output, files[0]))).toString(), cdp.trace)
    },
  )
}

test('a late trace read cannot save a file after finalization expires', async (t) => {
  const output = await temporaryOutput(t, 'comparison-late-trace-')
  const cdp = syntheticCdp({ churn: true })
  const send = cdp.session.send
  let finishRead
  cdp.session.send = async (name) => {
    if (name === 'IO.read')
      return new Promise((resolve) => {
        finishRead = resolve
      })
    return send(name)
  }
  await assert.rejects(
    tracePhase({
      ...cdp,
      browserSession: cdp.session,
      output,
      label: 'late',
      traced: true,
      finalizationMilliseconds: 10,
    }),
    /CPU process set changed/,
  )
  finishRead({ data: cdp.trace, eof: true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(cdp.calls.filter((name) => name === 'IO.close').length, 1)
  assert.deepEqual(await readdir(output), [])
})

for (const counters of [false, true]) {
  test(`a failed after snapshot retains completed work ${counters ? 'with counters' : 'by default'}`, async () => {
    const cdp = syntheticCdp()
    const send = cdp.session.send
    let snapshots = 0
    cdp.session.send = async (name) => {
      if (name === 'SystemInfo.getProcessInfo' && ++snapshots === 2) assert.fail('Snapshot failed')
      return send(name)
    }
    await assert.rejects(
      measureCpu(cdp.session, cdp.operation, {
        now: cdp.now,
        ...(counters ? { counterReader: counterReader() } : {}),
      }),
      (error) => {
        assert.match(error.message, /Snapshot failed/)
        assert.deepEqual(error.cpuFailure.before, [{ id: 1, type: 'renderer', cpuTime: 0 }])
        assert.equal(error.cpuFailure.after, null)
        assert.deepEqual(error.cpuFailure.operation.sample, cdp.sample)
        assert.deepEqual(error.cpuFailure.interval.after, { requested: 110, completed: 110 })
        return true
      },
    )
  })
}

function throwingDiagnostics() {
  const value = Object.create(null)
  for (const key of ['stack', 'partialLatency', 'cpuFailure', 'phaseFailure', Symbol.toPrimitive])
    Object.defineProperty(value, key, { get: () => assert.fail('Diagnostic getter ran') })
  return value
}

const rejectionCases = [
  ['undefined', () => undefined],
  ['null', () => null],
  ['false', () => false],
  ['zero', () => 0],
  ['empty string', () => ''],
  ['string', () => 'failed'],
  ['symbol', () => Symbol('failed')],
  ['frozen error', () => Object.freeze(new TypeError('Frozen failure'))],
  ['throwing accessors', throwingDiagnostics],
]

for (const [name, makeFailure] of rejectionCases) {
  for (const counters of [false, true]) {
    test(`CPU preserves ${name} rejection identity ${counters ? 'with counters' : 'by default'}`, async () => {
      const cdp = syntheticCdp()
      const failure = makeFailure()
      let evidence
      const reader = counterReader()
      reader.close = async () => {
        throw new TypeError('Close failed')
      }
      const observed = await measureCpu(cdp.session, () => Promise.reject(failure), {
        now: cdp.now,
        onFailure: (cpu) => {
          evidence = cpu
        },
        ...(counters ? { counterReader: reader } : {}),
      }).then(
        () => ({ rejected: false }),
        (error) => ({ rejected: true, error }),
      )
      assert.equal(observed.rejected, true)
      assert.equal(observed.error, failure)
      assert.equal(evidence.after.length, 1)
      assert.equal(typeof evidence.operation.error, 'string')
      assert.equal(cdp.calls.filter((call) => call === 'SystemInfo.getProcessInfo').length, 2)
    })
  }
}

for (const counters of [false, true]) {
  test(`CPU keeps fulfilled sample identity without another then read ${counters ? 'with counters' : 'by default'}`, async () => {
    const cdp = syntheticCdp()
    let reads = 0
    const sample = {
      get then() {
        assert.equal(++reads, 1)
        return undefined
      },
    }
    const promised = Promise.resolve(sample)
    const measured = await measureCpu(cdp.session, () => promised, {
      now: cdp.now,
      ...(counters ? { counterReader: counterReader() } : {}),
    })
    assert.equal(measured.sample, sample)
    assert.equal(reads, 1)
  })
}

for (const failedSnapshot of [1, 2]) {
  test(`native evidence survives CDP snapshot ${failedSnapshot} rejection`, async () => {
    const cdp = syntheticCdp()
    const raw = { requestedNs: '1', completedNs: '2', processes: {} }
    const metadata = { source: 'perf_event_open' }
    const setup = { requested: -2, completed: -1 }
    let closed = false
    let snapshots = 0
    const send = cdp.session.send
    cdp.session.send = async (name) => {
      if (name === 'SystemInfo.getProcessInfo' && ++snapshots === failedSnapshot)
        assert.fail('Snapshot failed')
      return send(name)
    }
    const reader = {
      metadata,
      setup,
      initialProcessInfo: [{ id: 1, type: 'renderer', cpuTime: 0 }],
      snapshot: async () => raw,
      close: async () => {
        closed = true
      },
    }
    await assert.rejects(
      measureCpu(cdp.session, cdp.operation, { now: cdp.now, counterReader: reader }),
      (error) => {
        const work = error.cpuFailure.workCounters
        assert.equal(work.snapshots.before, raw)
        assert.equal(work.snapshots.after, null)
        assert.equal(work.metadata, metadata)
        assert.equal(work.setup, setup)
        assert.deepEqual(work.boundary.before.native, { requested: 0, completed: 0 })
        assert.equal(work.boundary.after.native, null)
        assert.equal(work.status, 'skipped')
        return true
      },
    )
    assert.equal(closed, true)
  })
}

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function countCalls(cdp, name) {
  return cdp.calls.filter((call) => call === name).length
}

test(
  'recorder deadline ends browser tracing once and fences a later recorder result',
  { timeout: 1000 },
  async (t) => {
    const output = await temporaryOutput(t, 'comparison-recorder-stall-')
    const cdp = syntheticCdp()
    const recorder = deferred()
    const evaluate = cdp.page.evaluate
    cdp.page.evaluate = async (callback) => {
      if (callback.toString().includes('traceEnd')) return recorder.promise
      return evaluate(callback)
    }
    let failure
    await assert.rejects(
      tracePhase({
        ...cdp,
        browserSession: cdp.session,
        output,
        label: 'recorder',
        traced: true,
        finalizationMilliseconds: 10,
      }),
      (error) => {
        failure = error
        return /deadline exceeded/.test(error.message)
      },
    )
    assert.equal(countCalls(cdp, 'Tracing.end'), 1)
    assert.equal(countCalls(cdp, 'IO.close'), 1)
    assert.equal(countCalls(cdp, 'IO.read'), 0)
    recorder.resolve({ spans: [], counters: [], markers: [], ownership: [] })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(countCalls(cdp, 'Tracing.end'), 1)
    assert.equal(countCalls(cdp, 'IO.close'), 1)
    assert.equal(failure.phaseFailure.records, undefined)
    assert.deepEqual(await readdir(output), [])
    assert.equal(cdp.session.listenerCount('Tracing.tracingComplete'), 0)
  },
)

test(
  'completion after deadline closes its owned stream once without reading or saving',
  { timeout: 1000 },
  async (t) => {
    const output = await temporaryOutput(t, 'comparison-late-complete-')
    const cdp = syntheticCdp({ stall: 'tracingComplete' })
    t.after(() => cdp.session.emit('close'))
    await assert.rejects(
      tracePhase({
        ...cdp,
        browserSession: cdp.session,
        output,
        label: 'late',
        traced: true,
        finalizationMilliseconds: 10,
      }),
      /deadline exceeded/,
    )
    cdp.session.emit('Tracing.tracingComplete', { stream: 'late-owned-stream' })
    cdp.session.emit('Tracing.tracingComplete', { stream: 'unrelated-stream' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(countCalls(cdp, 'Tracing.end'), 1)
    assert.equal(countCalls(cdp, 'IO.close'), 1)
    assert.equal(countCalls(cdp, 'IO.read'), 0)
    assert.equal(cdp.session.listenerCount('Tracing.tracingComplete'), 0)
    assert.equal(cdp.session.listenerCount('close'), 0)
    assert.deepEqual(await readdir(output), [])
  },
)

test('session close removes cleanup-only completion ownership', { timeout: 1000 }, async (t) => {
  const output = await temporaryOutput(t, 'comparison-session-close-')
  const cdp = syntheticCdp({ stall: 'tracingComplete' })
  t.after(() => cdp.session.emit('close'))
  await assert.rejects(
    tracePhase({
      ...cdp,
      browserSession: cdp.session,
      output,
      label: 'close',
      traced: true,
      finalizationMilliseconds: 10,
    }),
    /deadline exceeded/,
  )
  assert.equal(cdp.session.listenerCount('Tracing.tracingComplete'), 1)
  cdp.session.emit('close')
  assert.equal(cdp.session.listenerCount('Tracing.tracingComplete'), 0)
  assert.equal(cdp.session.listenerCount('close'), 0)
  assert.equal(countCalls(cdp, 'IO.read'), 0)
})

for (const [name, makeFailure] of rejectionCases) {
  test(`trace cleanup preserves ${name} rejection identity`, async (t) => {
    const output = await temporaryOutput(t, 'comparison-cleanup-identity-')
    const cdp = syntheticCdp()
    const failure = makeFailure()
    const send = cdp.session.send
    cdp.session.send = async (name) => {
      if (name === 'Tracing.end') {
        cdp.session.emit('Tracing.tracingComplete', { stream: 'failed-end-stream' })
        throw failure
      }
      return send(name)
    }
    const observed = await tracePhase({
      ...cdp,
      browserSession: cdp.session,
      output,
      label: 'identity',
      traced: true,
    }).then(
      () => ({ rejected: false }),
      (error) => ({ rejected: true, error }),
    )
    assert.equal(observed.rejected, true)
    assert.equal(observed.error, failure)
    assert.equal(countCalls(cdp, 'IO.close'), 1)
    assert.equal(cdp.session.listenerCount('Tracing.tracingComplete'), 0)
  })
}

test('counter close failure retains both acquired native samples', async () => {
  const cdp = syntheticCdp()
  const raw = { requestedNs: '1', completedNs: '2', processes: {} }
  const failure = new TypeError('Counter close failed')
  const reader = {
    metadata: { source: 'perf_event_open' },
    initialProcessInfo: [{ id: 1, type: 'renderer', cpuTime: 0 }],
    snapshot: async () => raw,
    close: async () => {
      throw failure
    },
  }
  await assert.rejects(
    measureCpu(cdp.session, cdp.operation, { now: cdp.now, counterReader: reader }),
    (error) => {
      assert.equal(error, failure)
      assert.equal(error.cpuFailure.workCounters.snapshots.before, raw)
      assert.equal(error.cpuFailure.workCounters.snapshots.after, raw)
      assert.equal(error.cpuFailure.operation.sample, cdp.sample)
      return true
    },
  )
})

test('pending late completion cannot claim a later window stream', { timeout: 1000 }, async (t) => {
  const output = await temporaryOutput(t, 'comparison-trace-ownership-')
  const cdp = syntheticCdp({ stall: 'tracingComplete' })
  t.after(() => cdp.session.emit('close'))
  const options = {
    ...cdp,
    browserSession: cdp.session,
    output,
    label: 'first',
    traced: true,
    finalizationMilliseconds: 10,
  }
  await assert.rejects(tracePhase(options), /deadline exceeded/)
  await assert.rejects(
    tracePhase({ ...options, label: 'second' }),
    /Previous browser trace is still finalizing/,
  )
  assert.equal(countCalls(cdp, 'Tracing.start'), 1)
  assert.equal(cdp.session.listenerCount('Tracing.tracingComplete'), 1)
  cdp.session.emit('Tracing.tracingComplete', { stream: 'first-stream' })
  const send = cdp.session.send
  cdp.session.send = async (name, parameters) => {
    if (name === 'Tracing.end')
      cdp.session.emit('Tracing.tracingComplete', { stream: 'second-stream' })
    return send(name, parameters)
  }
  const result = await tracePhase({ ...options, label: 'second' })
  assert.equal(result.trace, 'second.trace.json.gz')
  assert.deepEqual(
    cdp.requests
      .filter(({ name }) => name === 'IO.close')
      .map(({ parameters }) => parameters.handle),
    ['first-stream', 'second-stream'],
  )
  assert.equal(cdp.session.listenerCount('Tracing.tracingComplete'), 0)
  assert.equal(cdp.session.listenerCount('close'), 0)
})

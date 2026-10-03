import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { setImmediate as nextTurn, setTimeout as pause } from 'node:timers/promises'
import { promisify } from 'node:util'
import test from 'node:test'
import {
  createGpuGate,
  GpuQualificationError,
  parseGpuSample,
  sampleNvidiaGpu,
} from './comparison-gpu.mjs'

const settings = {
  gpuIdleUtilizationPercent: 5,
  gpuWindowUtilizationPercent: 20,
  gpuComputeMemoryMiB: 1024,
  gpuSampleMilliseconds: 10,
  gpuIdleConsecutiveSamples: 2,
  gpuIdleWaitMilliseconds: 100,
  gpuCommandTimeoutMilliseconds: 20,
}
const reading = (utilizationPercent = 0, computeMemoryMiB = 0) => ({
  utilizationPercent,
  computeMemoryMiB,
  gpus: [],
  processes: [],
})
function clock() {
  let time = 0
  return {
    now: () => time,
    sleep: async (milliseconds) => {
      time += milliseconds
    },
  }
}

test('parse multi-GPU readings and retain owned and foreign processes', () => {
  const result = parseGpuSample('GPU-A, 5\nGPU-B, 80\n', 'GPU-A, 10, 341\nGPU-B, 20, 5900', [20])
  assert.equal(result.utilizationPercent, 80)
  assert.equal(result.computeMemoryMiB, 341)
  assert.deepEqual(result.processes, [
    { uuid: 'GPU-A', pid: 10, memoryMiB: 341, allowed: false },
    { uuid: 'GPU-B', pid: 20, memoryMiB: 5900, allowed: true },
  ])
})

test('empty compute-app list is valid; malformed readings fail closed', () => {
  assert.equal(parseGpuSample('GPU-A, 0', '').computeMemoryMiB, 0)
  for (const utilization of ['N/A', '-', 'NaN', '101', '-1', '']) {
    assert.throws(() => parseGpuSample(`GPU-A, ${utilization}`, ''))
  }
  assert.throws(() => parseGpuSample('', ''))
  assert.throws(() => parseGpuSample('GPU-A, 0', 'GPU-B, 2, 10'))
  assert.throws(() => parseGpuSample('GPU-A, 0', 'GPU-A, 2, N/A'))
})

test('NVIDIA commands run asynchronously in parallel with bounded execution', async () => {
  const pending = []
  const sampling = sampleNvidiaGpu({
    timeoutMilliseconds: 20,
    command: (binary, args, options) =>
      new Promise((resolve) => {
        assert.equal(binary, 'nvidia-smi')
        assert.equal(options.timeout, 20)
        pending.push({ args, resolve })
      }),
  })
  assert.equal(pending.length, 2)
  pending[0].resolve({ stdout: 'GPU-A, 0' })
  pending[1].resolve({ stdout: '' })
  assert.equal((await sampling).utilizationPercent, 0)
})

test('fractional NVIDIA budgets round up to a positive integer command timeout', async () => {
  for (const [timeoutMilliseconds, expected] of [
    [1755.1763169999977, 1756],
    [0.125, 1],
  ]) {
    const timeouts = []
    const result = await sampleNvidiaGpu({
      timeoutMilliseconds,
      command: async (_binary, args, options) => {
        timeouts.push(options.timeout)
        assert.equal(options.timeout, expected)
        return { stdout: args[0].startsWith('--query-gpu=') ? 'GPU-A, 0' : '' }
      },
    })
    assert.equal(result.utilizationPercent, 0)
    assert.deepEqual(timeouts, [expected, expected])
  }
})

test('empty successful GPU output fails closed with exact command diagnostics', async () => {
  const gate = createGpuGate(settings, {
    platform: 'linux',
    sample: (timeoutMilliseconds) =>
      sampleNvidiaGpu({
        timeoutMilliseconds,
        command: async (_binary, args) => ({
          stdout: args[0].startsWith('--query-gpu=') ? '' : 'GPU-A, 42, 12\n',
          stderr: 'driver diagnostic\n',
        }),
      }),
  })
  await assert.rejects(gate.waitForIdle(), (error) => {
    const failure = error.evidence.samplingError
    assert.equal(failure.code, 'ERR_ASSERTION')
    assert.match(failure.message, /at least one GPU/)
    assert.equal(error.evidence.qualified, false)
    assert.equal(failure.commands.length, 2)
    assert.deepEqual(failure.commands[0].args, [
      '--query-gpu=uuid,utilization.gpu',
      '--format=csv,noheader,nounits',
    ])
    assert.equal(failure.commands[0].binary, 'nvidia-smi')
    assert.equal(failure.commands[0].code, 0)
    assert.equal(failure.commands[0].stdout, '')
    assert.equal(failure.commands[0].stderr, 'driver diagnostic\n')
    assert.equal(failure.commands[1].stdout, 'GPU-A, 42, 12\n')
    for (const command of failure.commands) {
      assert(Number.isFinite(command.started))
      assert(command.completed >= command.started)
    }
    return true
  })
})

test('command rejection drains both queries and preserves stdout, stderr and termination status', async () => {
  let completeCompute
  const compute = new Promise((resolve) => {
    completeCompute = resolve
  })
  let settled = false
  const sampling = sampleNvidiaGpu({
    timeoutMilliseconds: 20,
    command: async (_binary, args) => {
      if (args[0].startsWith('--query-compute-apps=')) return compute
      throw Object.assign(new Error('driver failed'), {
        code: 9,
        signal: 'SIGTERM',
        killed: true,
        stdout: 'partial GPU output',
        stderr: 'driver error',
      })
    },
  }).finally(() => {
    settled = true
  })
  await nextTurn()
  assert.equal(settled, false)
  completeCompute({ stdout: '', stderr: '' })
  await assert.rejects(sampling, (error) => {
    assert.equal(error.code, 9)
    assert.deepEqual(
      error.samplingCommands.map(({ code, stdout, stderr, signal }) => ({
        code,
        stdout,
        stderr,
        signal,
      })),
      [
        {
          code: 9,
          stdout: 'partial GPU output',
          stderr: 'driver error',
          signal: 'SIGTERM',
        },
        { code: 0, stdout: '', stderr: '', signal: null },
      ],
    )
    return true
  })
})

test('idle gate resets consecutive samples and tolerates resident desktop memory', async () => {
  const samples = [reading(0, 341), reading(30, 341), reading(0, 341), reading(5, 1024)]
  const gate = createGpuGate(settings, {
    platform: 'linux',
    ...clock(),
    sample: async () => samples.shift(),
  })
  const result = await gate.waitForIdle()
  assert.equal(result.status, 'qualified')
  assert.equal(result.samples.length, 4)
  assert.equal(result.waitMilliseconds, 30)
})

test('busy GPU gives up at the configured bound and retains evidence', async () => {
  const time = clock()
  const timeouts = []
  const gate = createGpuGate(settings, {
    platform: 'linux',
    ...time,
    sample: async (timeout) => {
      timeouts.push(timeout)
      return reading(1, 5900)
    },
  })
  await assert.rejects(gate.waitForIdle(), (error) => {
    assert(error instanceof GpuQualificationError)
    assert.equal(error.evidence.status, 'failed')
    assert.equal(error.evidence.waitMilliseconds, 100)
    assert.equal(error.evidence.samples.length, 10)
    return true
  })
  assert.equal(timeouts.at(-1), 10)
})

test('missing NVIDIA tooling and other platforms record skip reasons', async () => {
  const absent = Object.assign(new Error('tool absent'), { code: 'ENOENT' })
  const gate = createGpuGate(settings, {
    platform: 'linux',
    sample: async () => {
      throw absent
    },
  })
  const idle = await gate.waitForIdle()
  assert.equal(idle.status, 'skipped')
  assert.equal(idle.skipReason, 'nvidia-smi is unavailable')
  const window = await gate.monitorWindow(async () => 42)
  assert.equal(window.value, 42)
  assert.equal(window.gpu.skipReason, idle.skipReason)
  const other = createGpuGate(settings, {
    platform: 'darwin',
    sample: async () => assert.fail(),
  })
  assert.match((await other.waitForIdle()).skipReason, /Linux/)
})

test('driver and repeated command timeouts fail qualification rather than skip', async () => {
  for (const code of [1, 'ETIMEDOUT']) {
    const gate = createGpuGate(settings, {
      platform: 'linux',
      ...clock(),
      sample: async () => {
        throw Object.assign(new Error('sampling failed'), { code })
      },
    })
    await assert.rejects(gate.waitForIdle(), (error) => {
      assert.equal(error.evidence.samplingError.code, code)
      assert.equal(error.evidence.status, 'failed')
      return true
    })
  }
})

test('measurement qualifies benchmark GPU load within the configured threshold', async () => {
  let samples = 0
  const gate = createGpuGate(settings, {
    platform: 'linux',
    sample: async () => {
      samples++
      return reading(20, 341)
    },
  })
  const result = await gate.monitorWindow(async () => 'measured')
  assert.equal(result.value, 'measured')
  assert.equal(result.gpu.status, 'qualified')
  assert.equal(samples, 2)
})

test('measurement detects activity during window and drains the sampler', async () => {
  let resolveSample
  const busySample = new Promise((resolve) => {
    resolveSample = resolve
  })
  let calls = 0
  const gate = createGpuGate(
    { ...settings, gpuSampleMilliseconds: 1 },
    {
      platform: 'linux',
      sample: async () => {
        calls++
        if (calls === 1) return reading(0, 341)
        resolveSample()
        return reading(10, 5900)
      },
    },
  )
  await assert.rejects(
    gate.monitorWindow(async () => {
      await busySample
    }),
    (error) => {
      assert.equal(error.evidence.samples.length, 2)
      assert.match(error.message, /External NVIDIA compute/)
      return true
    },
  )
  assert.equal(calls, 2)
})

test('window rejects foreign compute before starting and at its final sample', async () => {
  const gate = createGpuGate(settings, {
    platform: 'linux',
    sample: async () => reading(0, 5900),
  })
  await assert.rejects(
    gate.monitorWindow(async () => assert.fail()),
    GpuQualificationError,
  )
  let calls = 0
  const final = createGpuGate(settings, {
    platform: 'linux',
    sample: async () => reading(0, ++calls === 1 ? 341 : 5900),
  })
  await assert.rejects(
    final.monitorWindow(async () => 42),
    GpuQualificationError,
  )
})

test('operation failure terminates sampling without leaving a polling timer', async () => {
  let calls = 0
  const gate = createGpuGate(settings, {
    platform: 'linux',
    sample: async () => {
      calls++
      return reading()
    },
  })
  const failure = new Error('operation failed')
  await assert.rejects(
    gate.monitorWindow(async () => {
      throw failure
    }),
    (error) => error === failure,
  )
  assert.equal(calls, 1)
})

test('real async command timeout kills a stuck sampling subprocess', async () => {
  const children = []
  const command = async (_binary, _args, options) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    })
    children.push(child)
    const timer = setTimeout(() => child.kill(), options.timeout)
    try {
      await once(child, 'exit')
      throw Object.assign(new Error('sampling timed out'), {
        code: 'ETIMEDOUT',
      })
    } finally {
      clearTimeout(timer)
    }
  }
  await assert.rejects(sampleNvidiaGpu({ command, timeoutMilliseconds: 20 }), (error) => {
    assert.equal(error.code, 'ETIMEDOUT')
    return true
  })
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    }),
  )
})

test('absent hardware records a skip, but disappearing tooling invalidates a window', async () => {
  const absent = createGpuGate(settings, {
    platform: 'linux',
    sample: async () => {
      throw Object.assign(new Error('absent hardware'), {
        code: 6,
        stdout: 'No devices were found',
      })
    },
  })
  assert.equal((await absent.waitForIdle()).skipReason, 'No NVIDIA GPU devices found')
  let calls = 0
  const disappearing = createGpuGate(settings, {
    platform: 'linux',
    sample: async () => {
      if (++calls === 1) return reading()
      throw Object.assign(new Error('tool disappeared'), { code: 'ENOENT' })
    },
  })
  await assert.rejects(
    disappearing.monitorWindow(async () => 42),
    (error) => {
      assert.equal(error.evidence.status, 'failed')
      assert.equal(error.evidence.samplingError.code, 'ENOENT')
      return true
    },
  )
})

test('busy utilization disqualifies before, during, and after a measurement', async () => {
  for (const busyAt of [1, 2, 3]) {
    let calls = 0
    let resolveDuring
    const during = new Promise((resolve) => {
      resolveDuring = resolve
    })
    const gate = createGpuGate(
      { ...settings, gpuSampleMilliseconds: 1 },
      {
        platform: 'linux',
        sample: async () => {
          calls++
          if (calls === 2) resolveDuring()
          return reading(calls === busyAt ? 21 : 0, 341)
        },
      },
    )
    await assert.rejects(
      gate.monitorWindow(async () => {
        await during
      }),
      (error) => {
        assert.equal(error.evidence.qualified, false)
        assert.match(error.message, /utilization exceeded/)
        return true
      },
    )
    assert.equal(calls, busyAt)
  }
})

test('sampler evidence wins when both monitoring and operation fail', async () => {
  let resolveDuring
  const during = new Promise((resolve) => {
    resolveDuring = resolve
  })
  let calls = 0
  const gate = createGpuGate(
    { ...settings, gpuSampleMilliseconds: 1 },
    {
      platform: 'linux',
      sample: async () => {
        if (++calls === 1) return reading()
        resolveDuring()
        throw Object.assign(new Error('sampler failure'), {
          code: 'ETIMEDOUT',
        })
      },
    },
  )
  await assert.rejects(
    gate.monitorWindow(async () => {
      await during
      throw new Error('operation failure')
    }),
    (error) => {
      assert(error instanceof GpuQualificationError)
      assert.equal(error.evidence.qualified, false)
      assert.equal(error.evidence.samplingError.code, 'ETIMEDOUT')
      return true
    },
  )
  assert.equal(calls, 2)
})

test('qualification booleans and evidence settings reflect GPU policy only', async () => {
  const gate = createGpuGate(
    { ...settings, unrelatedSetting: 'omit' },
    {
      platform: 'linux',
      ...clock(),
      sample: async () => reading(),
    },
  )
  const idle = await gate.waitForIdle()
  assert.equal(idle.qualified, true)
  assert.deepEqual(idle.settings, settings)
  const skipped = createGpuGate(settings, { platform: 'darwin' })
  assert.equal((await skipped.waitForIdle()).qualified, true)
  assert.equal((await skipped.monitorWindow(async () => 42)).gpu.qualified, true)
  const failed = createGpuGate(settings, {
    platform: 'linux',
    ...clock(),
    sample: async () => reading(100),
  })
  await assert.rejects(failed.waitForIdle(), (error) => error.evidence.qualified === false)
})

test('threshold settings are required and validated', () => {
  assert.throws(() => createGpuGate({}))
  assert.throws(() => createGpuGate({ ...settings, gpuIdleConsecutiveSamples: 0 }))
  assert.throws(() => createGpuGate({ ...settings, gpuIdleUtilizationPercent: 101 }))
  assert.throws(() => createGpuGate({ ...settings, gpuComputeMemoryMiB: -1 }))
})

test('new foreign PIDs below the memory threshold invalidate intermediate and final samples', async () => {
  for (const appearDuring of [true, false]) {
    let calls = 0
    let resolveDuring
    const during = new Promise((resolve) => {
      resolveDuring = resolve
    })
    const gate = createGpuGate(
      { ...settings, gpuSampleMilliseconds: 1 },
      {
        platform: 'linux',
        sample: async () => {
          const compute = ++calls === 1 ? 'GPU-A, 10, 341' : 'GPU-A, 10, 341\nGPU-A, 20, 1'
          if (calls === 2) resolveDuring()
          return parseGpuSample('GPU-A, 0', compute)
        },
      },
    )
    await assert.rejects(
      gate.monitorWindow(async () => {
        if (appearDuring) await during
      }),
      (error) => {
        assert.match(error.message, /External NVIDIA compute/)
        assert.deepEqual(error.evidence.baselineForeignComputePids, [10])
        assert.deepEqual(error.evidence.newForeignComputePids, [20])
        assert.equal(error.evidence.samples.at(-1).computeMemoryMiB, 342)
        return true
      },
    )
    assert.equal(calls, 2)
  }
})

test('foreign PID starting after idle qualification rejects before operation starts', async () => {
  let calls = 0
  const gate = createGpuGate(settings, {
    platform: 'linux',
    ...clock(),
    sample: async () =>
      parseGpuSample('GPU-A, 0', ++calls <= 2 ? 'GPU-A, 10, 341' : 'GPU-A, 20, 1'),
  })
  await gate.waitForIdle()
  await assert.rejects(
    gate.monitorWindow(async () => assert.fail('operation must not start')),
    (error) => {
      assert.deepEqual(error.evidence.baselineForeignComputePids, [10])
      assert.deepEqual(error.evidence.newForeignComputePids, [20])
      return true
    },
  )
})

test('existing foreign PIDs and new owned PIDs remain qualified', async () => {
  let calls = 0
  const gate = createGpuGate(settings, {
    platform: 'linux',
    sample: async () =>
      parseGpuSample(
        'GPU-A, 0',
        ++calls === 1 ? 'GPU-A, 10, 341' : 'GPU-A, 10, 350\nGPU-A, 20, 5900',
        [20],
      ),
  })
  assert.equal((await gate.monitorWindow(async () => 42)).gpu.qualified, true)
})

test('idle timeout retries reset consecutive samples and remain within the wait budget', async () => {
  for (const failure of [{ code: 'ETIMEDOUT' }, { killed: true, signal: 'SIGTERM' }]) {
    const time = clock()
    const timeouts = []
    let calls = 0
    const gate = createGpuGate(settings, {
      platform: 'linux',
      ...time,
      sample: async (timeout) => {
        timeouts.push(timeout)
        if (++calls !== 2) return reading()
        await time.sleep(timeout)
        throw Object.assign(new Error('sampling timed out'), failure)
      },
    })
    const result = await gate.waitForIdle()
    assert.equal(calls, 4)
    assert.equal(result.qualified, true)
    assert.equal(result.waitMilliseconds, 50)
    assert.equal(result.samples.length, 3)
    assert.equal(result.samplingTimeouts.length, 1)
    assert.deepEqual(timeouts, [20, 20, 20, 20])
  }
})

test('repeated idle timeouts clamp command timeout to remaining wait budget', async () => {
  const time = clock()
  const timeouts = []
  const gate = createGpuGate(settings, {
    platform: 'linux',
    ...time,
    sample: async (timeout) => {
      timeouts.push(timeout)
      await time.sleep(timeout)
      throw Object.assign(new Error('sampling timed out'), {
        code: 'ETIMEDOUT',
      })
    },
  })
  await assert.rejects(gate.waitForIdle(), (error) => {
    assert.equal(error.evidence.waitMilliseconds, 100)
    assert.equal(error.evidence.samplingTimeouts.length, 4)
    assert.match(error.message, /idle wait expired/)
    return true
  })
  assert.deepEqual(timeouts, [20, 20, 20, 10])
})

test('window polling override changes cadence and evidence while retaining boundary samples', async () => {
  const intervals = []
  let calls = 0
  const gate = createGpuGate(settings, {
    platform: 'linux',
    sample: async () => {
      calls++
      return reading()
    },
    sleep: async (milliseconds, _value, { signal }) => {
      intervals.push(milliseconds)
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    },
  })
  const result = await gate.monitorWindow(async () => 42, {
    sampleMilliseconds: 250,
  })
  assert.deepEqual(intervals, [250])
  assert.equal(calls, 2)
  assert.equal(result.gpu.settings.gpuSampleMilliseconds, 250)
  await assert.rejects(
    gate.monitorWindow(async () => 42, { sampleMilliseconds: 0 }),
    /Positive sampleMilliseconds/,
  )
})

for (const driverQuery of ['--query-gpu=', '--query-compute-apps=']) {
  test(`mixed timeout and driver failure fail qualification with driver in ${driverQuery}`, async () => {
    let calls = 0
    const gate = createGpuGate(settings, {
      platform: 'linux',
      ...clock(),
      command: async (_binary, args) => {
        if (++calls > 2)
          return {
            stdout: args[0].startsWith('--query-gpu=') ? 'GPU-A, 0' : '',
          }
        if (args[0].startsWith(driverQuery))
          throw Object.assign(new Error('driver failure'), {
            code: 9,
            killed: false,
            stdout: 'partial driver output',
            stderr: 'driver failed',
          })
        await nextTurn()
        throw Object.assign(new Error('timeout'), {
          code: 'ETIMEDOUT',
          killed: true,
          signal: 'SIGTERM',
        })
      },
    })
    await assert.rejects(gate.waitForIdle(), (error) => {
      assert.equal(error.evidence.qualified, false)
      assert.equal(error.evidence.samplingError.code, 9)
      assert.equal(error.evidence.samplingError.commands.length, 2)
      assert.deepEqual(
        error.evidence.samplingError.failures.map(({ code }) => code).sort(),
        [9, 'ETIMEDOUT'].sort(),
      )
      return true
    })
    assert.equal(calls, 2, 'a nonretryable peer failure must not be hidden by retry')
  })
}

test('a rejected query plus pending adapter query has a finite sampling outcome', async () => {
  const gate = createGpuGate(settings, {
    platform: 'linux',
    command: (_binary, args) => {
      if (args[0].startsWith('--query-gpu='))
        return Promise.reject(Object.assign(new Error('driver failed'), { code: 9 }))
      return new Promise(() => {})
    },
  })
  const result = gate.waitForIdle().then(
    () => null,
    (error) => error,
  )
  const outcome = await Promise.race([result, pause(500).then(() => 'pending')])
  assert.notEqual(outcome, 'pending')
  assert.equal(outcome.evidence.qualified, false)
  assert.equal(outcome.evidence.samplingError.code, 9)
  assert.equal(outcome.evidence.samplingError.commands[1].deadlineExpired, true)
})

test('owned SIGTERM-resistant command is killed and bounded while its peer fails', async () => {
  const execute = promisify(execFile)
  let pending
  const gate = createGpuGate(
    { ...settings, gpuCommandTimeoutMilliseconds: 200 },
    {
      platform: 'linux',
      sample: () =>
        sampleNvidiaGpu({
          timeoutMilliseconds: 200,
          command: (_binary, args, options) => {
            if (args[0].startsWith('--query-gpu='))
              return Promise.reject(Object.assign(new Error('driver failed'), { code: 9 }))
            pending = execute(
              process.execPath,
              ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
              { ...options, killSignal: 'SIGTERM' },
            )
            return pending
          },
        }),
    },
  )
  try {
    const result = gate.waitForIdle().then(
      () => null,
      (error) => error,
    )
    const outcome = await Promise.race([result, pause(600).then(() => 'pending')])
    assert.notEqual(outcome, 'pending', 'a resistant owned peer must reach the hard deadline')
    assert.equal(outcome.evidence.qualified, false)
    assert.equal(outcome.evidence.samplingError.commands[1].deadlineExpired, true)
    await assert.rejects(pending)
    assert.equal(pending.child.signalCode, 'SIGKILL')
  } finally {
    pending?.child?.kill('SIGKILL')
    await pending?.catch(() => {})
  }
})

for (const stdout of ['GPU-A, 0', '']) {
  test(`exit-zero termination metadata cannot qualify ${stdout ? 'valid partial' : 'empty'} output`, async () => {
    const gate = createGpuGate(settings, {
      platform: 'linux',
      ...clock(),
      command: (_binary, args) => {
        const pending = Promise.resolve({
          stdout: args[0].startsWith('--query-gpu=') ? stdout : '',
          stderr: 'termination output',
        })
        pending.child = { killed: true, exitCode: 0, signalCode: null }
        return pending
      },
    })
    await assert.rejects(gate.waitForIdle(), (error) => {
      assert.equal(error.evidence.qualified, false)
      assert.equal(error.evidence.samplingError.code, 'ETIMEDOUT')
      const receipt = error.evidence.samplingError.commands[0]
      assert.equal(receipt.killed, true)
      assert.equal(receipt.exitCode, 0)
      assert.equal(receipt.stdout, stdout)
      return true
    })
  })
}

test('real execFile timeout preserves partial streams and never reads as success', async () => {
  const execute = promisify(execFile)
  const children = []
  const gate = createGpuGate(settings, {
    platform: 'linux',
    sample: () =>
      sampleNvidiaGpu({
        timeoutMilliseconds: 200,
        command: (_binary, args, options) => {
          const stdout = args[0].startsWith('--query-gpu=') ? 'GPU-A, 0' : ''
          const pending = execute(
            process.execPath,
            [
              '-e',
              `process.on('SIGTERM', () => process.exit(0)); process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write('partial stderr'); setInterval(() => {}, 1000)`,
            ],
            options,
          )
          children.push(pending)
          return pending
        },
      }),
  })
  try {
    await assert.rejects(
      gate.monitorWindow(async () => assert.fail('operation must not start')),
      (error) => {
        assert.equal(error.evidence.qualified, false)
        const receipt = error.evidence.samplingError.commands[0]
        assert.equal(receipt.code, 'ETIMEDOUT')
        assert.equal(receipt.killed, true)
        assert.equal(receipt.stdout, 'GPU-A, 0')
        assert.equal(receipt.stderr, 'partial stderr')
        return true
      },
    )
    await Promise.allSettled(children)
    assert(children.every((pending) => pending.child.signalCode === 'SIGKILL'))
  } finally {
    for (const pending of children) pending.child.kill('SIGKILL')
    await Promise.allSettled(children)
  }
})

for (const [malformedGpu, peerCode] of [
  [true, 'ETIMEDOUT'],
  [false, 'ETIMEDOUT'],
  [true, 'ENOENT'],
  [false, 'ENOENT'],
]) {
  test(`malformed successful ${malformedGpu ? 'GPU' : 'compute'} query is not hidden by ${peerCode} peer`, async () => {
    let calls = 0
    const gate = createGpuGate(settings, {
      platform: 'linux',
      ...clock(),
      command: async (_binary, args) => {
        const gpu = args[0].startsWith('--query-gpu=')
        if (++calls > 2) return { stdout: gpu ? 'GPU-A, 0' : '' }
        if (gpu === malformedGpu) return { stdout: gpu ? '' : 'GPU-A, invalid-pid, 5' }
        throw Object.assign(new Error('peer failure'), { code: peerCode })
      },
    })
    await assert.rejects(gate.waitForIdle(), (error) => {
      assert.equal(error.evidence.qualified, false)
      assert.equal(
        error.evidence.samplingError.code,
        peerCode === 'ETIMEDOUT' ? 'ERR_ASSERTION' : peerCode,
      )
      assert.equal(error.evidence.samplingError.commands.length, 2)
      assert.equal(error.evidence.samplingError.failures.length, 2)
      return true
    })
    assert.equal(calls, 2)
  })
}

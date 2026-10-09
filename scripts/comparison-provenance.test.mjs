import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  observeOwnedBrowserProvenance,
  assertBrowserAcceptanceRequest,
  BrowserProvenanceError,
} from './comparison-provenance.mjs'

const product = 'Chrome/154.0.8037.93'
const taskRoot = join(tmpdir(), 'synthetic-owned-provenance')
const requested = ['--force-device-scale-factor=2', '--max-active-webgl-contexts=32']

function boundary({
  platform = 'linux',
  root = taskRoot,
  parentPid = 100,
  afterParentPid = parentPid,
  startTime = '123456',
  afterStartTime = startTime,
  version = { product, revision: 'synthetic-revision', userAgent: 'synthetic-UA' },
  processes = [
    { id: 101, type: 'browser' },
    { id: 102, type: 'GPU' },
  ],
  argv = [
    'browser executable',
    '--user-data-dir=' + join(root, 'tmp', 'playwright_profile'),
  ].concat(requested),
  raw = Buffer.from(argv.join('\0') + '\0'),
  rawMac = argv.join(' ') + '\n',
  executable = join(tmpdir(), 'actual-browser-executable'),
  failure,
} = {}) {
  const calls = []
  let identities = 0
  const fail = (operation) => {
    if (failure?.operation === operation) throw failure.error
  }
  const session = {
    async send(method) {
      calls.push(method)
      fail(method)
      if (method === 'Browser.getBrowserCommandLine') {
        throw new TypeError('Command line not returned because --enable-automation not set.')
      }
      if (method === 'Browser.getVersion') return version
      assert.equal(method, 'SystemInfo.getProcessInfo')
      return { processInfo: processes }
    },
  }
  const identity = () => {
    const parent = identities++ === 0 ? parentPid : afterParentPid
    const time = identities === 1 ? startTime : afterStartTime
    return `101 (browser ) with spaces) S ${parent} ${Array(17).fill('0').join(' ')} ${time} 0\n`
  }
  const read = async (path, encoding) => {
    const operation = path.endsWith('/stat') ? 'identity' : 'argv'
    calls.push(operation)
    fail(operation)
    if (operation === 'identity') {
      assert.equal(path, '/proc/101/stat')
      assert.equal(encoding, 'utf8')
      return identity()
    }
    assert.equal(path, '/proc/101/cmdline')
    assert.equal(encoding, undefined)
    return raw
  }
  const readLink = async (path) => {
    assert.equal(path, '/proc/101/exe')
    calls.push('executable')
    fail('executable')
    return executable
  }
  const command = async (binary, args, options) => {
    assert.equal(binary, 'ps')
    assert.equal(options.encoding, 'utf8')
    assert.equal(options.timeout, 2000)
    assert.equal(options.killSignal, 'SIGKILL')
    const operation = args.at(-1) === 'ppid=' ? 'identity' : 'argv'
    calls.push(operation)
    fail(operation)
    if (operation === 'identity') {
      assert.deepEqual(args, ['-p', '101', '-o', 'ppid='])
      return { stdout: `${identities++ === 0 ? parentPid : afterParentPid}\n` }
    }
    assert.deepEqual(args, ['-ww', '-p', '101', '-o', 'args='])
    return { stdout: rawMac }
  }
  return {
    calls,
    session,
    raw,
    rawMac,
    observe: (overrides = {}) =>
      observeOwnedBrowserProvenance({
        session,
        taskRoot: root,
        requestedArguments: requested,
        expectedProduct: product,
        ownerPid: 100,
        platform,
        command,
        read,
        readLink,
        ...overrides,
      }),
  }
}

test('known-good CDP boundary exposes the actual browser build', async () => {
  const external = boundary()
  assert.equal((await external.session.send('Browser.getVersion')).product, product)
  assert.deepEqual(external.calls, ['Browser.getVersion'])
})

test('legacy launch provenance refuses the same known-good automation-free boundary', async () => {
  const external = boundary()
  await assert.rejects(
    external.session.send('Browser.getBrowserCommandLine'),
    /--enable-automation not set/,
  )
  assert.deepEqual(external.calls, ['Browser.getBrowserCommandLine'])
})

for (const platform of ['linux', 'darwin']) {
  test(`${platform} observes one directly owned browser without the unavailable CDP method`, async () => {
    const external = boundary({ platform })
    const result = await external.observe()
    assert.deepEqual(
      external.calls,
      ['Browser.getVersion', 'SystemInfo.getProcessInfo', 'identity', 'argv'].concat(
        platform === 'linux' ? ['executable'] : [],
        ['identity'],
      ),
    )
    assert.equal(result.status, 'observed-owned-process')
    assert.equal(result.browserPid, 101)
    assert.equal(result.ownerPid, 100)
    assert.equal(result.observedParentPid, 100)
    assert.equal(result.observedProfile, join(taskRoot, 'tmp', 'playwright_profile'))
    assert.deepEqual(result.browserVersion, {
      product,
      revision: 'synthetic-revision',
      userAgent: 'synthetic-UA',
    })
    assert.deepEqual(result.requestedArguments, requested)
    assert.match(result.requestedArgumentsQualification, /Requested.*observed.*independently/)
    assert.equal(result.cdpBrowserCommandLine.invoked, false)
    assert.equal(result.cdpBrowserCommandLine.status, 'NOT_QUERIED_AUTOMATION_DEPENDENT')
    assert.equal(result.environment.launchMode, 'headed')
    if (platform === 'linux') {
      assert.equal(result.rawObservedCommandLine, external.raw.toString('utf8'))
      assert.equal(result.rawCommandLineBase64, external.raw.toString('base64'))
      assert.equal(result.observedExecutable, join(tmpdir(), 'actual-browser-executable'))
      assert.equal(result.observedArgv0, 'browser executable')
      assert.equal(result.before.startTimeTicks, '123456')
      return
    }
    assert.equal(result.rawObservedCommandLine, external.rawMac)
    assert.equal(result.observedArguments, null)
    assert.equal(result.observedExecutable, null)
    assert.match(result.argumentRepresentation, /original argv boundaries.*unknown/)
  })

  test(`${platform} rejects a foreign parent before querying any raw argv`, async () => {
    const external = boundary({ platform, parentPid: 999 })
    await assert.rejects(external.observe(), /direct child before argv/)
    assert.deepEqual(external.calls, [
      'Browser.getVersion',
      'SystemInfo.getProcessInfo',
      'identity',
    ])
  })

  test(`${platform} rejects changed ownership after argv observation`, async () => {
    const external = boundary({ platform, afterParentPid: 999 })
    await assert.rejects(external.observe(), /must survive argv observation/)
  })

  for (const [name, argv, reason] of [
    [
      'foreign profile',
      ['browser', '--user-data-dir=' + join(tmpdir(), 'foreign')].concat(requested),
      /task-owned/,
    ],
    [
      'profile traversal',
      ['browser', '--user-data-dir=' + taskRoot + '/tmp/../foreign'].concat(requested),
      /task-owned/,
    ],
    [
      'profile dot segment',
      ['browser', '--user-data-dir=' + taskRoot + '/tmp/./profile'].concat(requested),
      /task-owned/,
    ],
    [
      'duplicate profile',
      [
        'browser',
        '--user-data-dir=' + taskRoot + '/tmp/one',
        '--user-data-dir=' + taskRoot + '/tmp/two',
      ].concat(requested),
      /Exactly one observed/,
    ],
    [
      'split profile token',
      ['browser', '--user-data-dir', taskRoot + '/tmp/one'].concat(requested),
      /--user-data-dir= token/,
    ],
    ['missing profile', ['browser'].concat(requested), /Exactly one observed/],
    [
      'requested flag prefix mismatch',
      [
        'browser',
        '--user-data-dir=' + taskRoot + '/tmp/one',
        requested[0],
        '--max-active-webgl-contexts=320',
      ],
      /argument missing/,
    ],
  ]) {
    test(`${platform} rejects ${name}`, async () => {
      await assert.rejects(boundary({ platform, argv }).observe(), reason)
    })
  }

  for (const operation of [
    'Browser.getVersion',
    'SystemInfo.getProcessInfo',
    'identity',
    'argv',
  ].concat(platform === 'linux' ? ['executable'] : [])) {
    test(`${platform} propagates ${operation} errors without empty successful provenance`, async () => {
      const error = Object.assign(new TypeError('synthetic external boundary failure'), {
        code: 'EXTERNAL_FAILURE',
      })
      const external = boundary({ platform, failure: { operation, error } })
      await assert.rejects(external.observe(), (observed) => observed === error)
      assert(!external.calls.includes('Browser.getBrowserCommandLine'))
    })
  }
}

test('wrong actual browser product/build fails before process enumeration or argv', async () => {
  for (const wrong of [
    'Chrome/999.0.0.0',
    'Firefox/154.0.8037.93',
    'HeadlessChrome/154.0.8037.93',
    undefined,
  ]) {
    const external = boundary({ version: { product: wrong } })
    await assert.rejects(external.observe(), /Actual browser product\/build/)
    assert.deepEqual(external.calls, ['Browser.getVersion'])
  }
})

test('absent, ambiguous and invalid CDP browser PIDs fail before OS queries', async () => {
  for (const processes of [
    [],
    [{ type: 'GPU', id: 102 }],
    [{ type: 'browser', id: 0 }],
    [{ type: 'browser', id: -1 }],
    [{ type: 'browser', id: '101' }],
    [{ type: 'browser', id: 1.5 }],
    [
      { type: 'browser', id: 101 },
      { type: 'browser', id: 103 },
    ],
  ]) {
    const external = boundary({ processes })
    await assert.rejects(external.observe())
    assert.deepEqual(external.calls, ['Browser.getVersion', 'SystemInfo.getProcessInfo'])
  }
})

test('Linux detects PID reuse across argv observation', async () => {
  await assert.rejects(boundary({ afterStartTime: '123457' }).observe(), /lifetime.*must survive/)
})

test('empty or malformed process identity never becomes a zero PID pass', async () => {
  for (const platform of ['linux', 'darwin']) {
    for (const parentPid of ['', 0, 'unknown', '100 trailing']) {
      const external = boundary({ platform, parentPid })
      await assert.rejects(external.observe())
      assert(!external.calls.includes('argv'))
    }
  }
  for (const startTime of ['', 'unknown', '0']) {
    const external = boundary({ startTime })
    await assert.rejects(external.observe(), /start time is unavailable/)
    assert(!external.calls.includes('argv'))
  }
})

test('Linux rejects empty, unterminated and invalid UTF-8 argv', async () => {
  for (const raw of [
    Buffer.alloc(0),
    Buffer.from('browser'),
    Buffer.from([0xff, 0]),
    Buffer.from([0]),
  ]) {
    await assert.rejects(boundary({ raw }).observe())
  }
})

test('macOS rejects unavailable argv and ambiguous whitespace in caller inputs', async () => {
  for (const rawMac of ['', '\n', '\0'])
    await assert.rejects(
      boundary({ platform: 'darwin', rawMac }).observe(),
      /command line is unavailable/,
    )
  const external = boundary({ platform: 'darwin', root: taskRoot + ' with spaces' })
  await assert.rejects(external.observe(), /whitespace-free/)
  assert.deepEqual(external.calls, [])
  await assert.rejects(
    boundary({ platform: 'darwin' }).observe({ requestedArguments: ['--option=a b'] }),
    /whitespace-free/,
  )
})

test('Linux preserves exact NUL-delimited tokens, whitespace and empty argv entries', async () => {
  const root = taskRoot + ' with spaces'
  const flags = ['--option=a b']
  const argv = [
    'browser executable',
    '--user-data-dir=' + root + '/tmp/profile with spaces',
  ].concat(flags, [''])
  const result = await boundary({ root, argv }).observe({ requestedArguments: flags })
  assert.deepEqual(result.observedArguments, argv)
  assert.equal(result.observedProfile, root + '/tmp/profile with spaces')
  await assert.rejects(
    boundary({
      argv: ['browser', '--user-data-dir=' + taskRoot + '/tmp/p', requested.join(' ')],
    }).observe(),
    /argument missing/,
  )
})

test('launch mode follows actual product and exact OS tokens', async () => {
  for (const platform of ['linux', 'darwin']) {
    for (const flag of ['--headless', '--headless=new', '--ozone-platform=headless']) {
      const argv = ['browser', '--user-data-dir=' + taskRoot + '/tmp/p'].concat(requested, [flag])
      assert.equal(
        (await boundary({ platform, argv }).observe()).environment.launchMode,
        'headless',
      )
    }
    const argv = ['browser', '--user-data-dir=' + taskRoot + '/tmp/p'].concat(requested, [
      '--headlessness',
    ])
    assert.equal((await boundary({ platform, argv }).observe()).environment.launchMode, 'headed')
    const headlessProduct = 'HeadlessChrome/154.0.8037.93'
    assert.equal(
      (
        await boundary({
          platform,
          version: { product: headlessProduct, userAgent: 'Mozilla/5.0 ' + headlessProduct },
        }).observe({
          expectedProduct: headlessProduct,
        })
      ).environment.launchMode,
      'headless',
    )
  }
})

test('unsupported platforms throw explicit unknown ownership and mode before any external call', async () => {
  const external = boundary({ platform: 'win32' })
  await assert.rejects(external.observe(), (error) => {
    assert(error instanceof BrowserProvenanceError)
    assert.equal(error.code, 'BROWSER_PROVENANCE_UNSUPPORTED')
    assert.deepEqual(error.evidence, {
      status: 'unsupported',
      qualified: false,
      platform: 'win32',
      environment: { headless: null, launchMode: 'unknown', requestedHeadless: null },
    })
    return true
  })
  assert.deepEqual(external.calls, [])
})

for (const platform of ['linux', 'darwin']) {
  test(`${platform} acceptance requires an explicitly headed request before any external query`, async () => {
    for (const requestedHeadless of [true, undefined]) {
      const external = boundary({ platform })
      await assert.rejects(external.observe({ acceptance: true, requestedHeadless }), (error) => {
        assert.equal(error.code, 'BROWSER_ACCEPTANCE_REQUIRES_HEADED')
        assert.equal(error.evidence.environment.headless, null)
        assert.equal(error.evidence.environment.launchMode, 'unknown')
        assert.equal(error.evidence.acceptanceModeGuard, 'rejected')
        return true
      })
      assert.deepEqual(external.calls, [])
    }
    const external = boundary({ platform })
    await assert.rejects(
      external.observe({
        acceptance: true,
        requestedHeadless: false,
        requestedArguments: requested.concat(['--headless']),
      }),
      /explicitly headed launch request/,
    )
    assert.deepEqual(external.calls, [])
  })

  test(`${platform} acceptance passes observed headed provenance without claiming hardware or presentation`, async () => {
    const result = await boundary({ platform }).observe({
      acceptance: true,
      requestedHeadless: false,
    })
    assert.deepEqual(result.environment, {
      headless: false,
      launchMode: 'headed',
      requestedHeadless: false,
    })
    assert.equal(result.acceptanceModeGuard, 'passed-headed')
    assert(!Object.hasOwn(result, 'hardwareQualified'))
    assert(!Object.hasOwn(result, 'presentationQualified'))
  })

  test(`${platform} contradictory actual mode rejects acceptance while retaining owned argv evidence`, async () => {
    const argv = ['browser', '--user-data-dir=' + taskRoot + '/tmp/p'].concat(requested, [
      '--headless=new',
    ])
    const diagnostic = await boundary({ platform, argv }).observe({ requestedHeadless: false })
    assert.deepEqual(diagnostic.environment, {
      headless: true,
      launchMode: 'contradictory',
      requestedHeadless: false,
    })
    await assert.rejects(
      boundary({ platform, argv }).observe({ acceptance: true, requestedHeadless: false }),
      (error) => {
        assert.equal(error.code, 'BROWSER_ACCEPTANCE_REQUIRES_HEADED')
        assert.deepEqual(error.evidence.environment, diagnostic.environment)
        assert.equal(error.evidence.acceptanceModeGuard, 'rejected')
        assert.equal(error.evidence.rawObservedCommandLine, diagnostic.rawObservedCommandLine)
        assert.equal(error.evidence.browserPid, 101)
        return true
      },
    )
    const requestedHeadlessDiagnostic = await boundary({ platform }).observe({
      requestedHeadless: true,
    })
    assert.deepEqual(requestedHeadlessDiagnostic.environment, {
      headless: false,
      launchMode: 'contradictory',
      requestedHeadless: true,
    })
  })

  test(`${platform} unknown observed headless switch value never qualifies acceptance`, async () => {
    const argv = ['browser', '--user-data-dir=' + taskRoot + '/tmp/p'].concat(requested, [
      '--headless=unexpected',
    ])
    const diagnostic = await boundary({ platform, argv }).observe()
    assert.equal(diagnostic.environment.headless, null)
    assert.equal(diagnostic.environment.launchMode, 'unknown')
    await assert.rejects(
      boundary({ platform, argv }).observe({ acceptance: true, requestedHeadless: false }),
      (error) => {
        assert.equal(error.evidence.environment.launchMode, 'unknown')
        assert.equal(error.evidence.environment.headless, null)
        assert.equal(error.evidence.acceptanceModeGuard, 'rejected')
        return true
      },
    )
  })
}

test('profile containment rejects filesystem-root shortcuts and empty descendants', async () => {
  const external = boundary()
  await assert.rejects(external.observe({ taskRoot: '/' }), /task-owned root/)
  assert.deepEqual(external.calls, [])
  const argv = ['browser', '--user-data-dir=' + taskRoot + '/tmp/'].concat(requested)
  await assert.rejects(boundary({ argv }).observe(), /task-owned Chrome profile/)
})

test('Linux headless-shell executable cannot qualify a headed request even without a headless flag', async () => {
  for (const name of ['chrome-headless-shell', 'headless_shell']) {
    const executable = join(tmpdir(), name)
    const external = boundary({ executable })
    await assert.rejects(
      external.observe({ acceptance: true, requestedHeadless: false }),
      (error) => {
        assert.equal(error.evidence.environment.headless, true)
        assert.equal(error.evidence.environment.launchMode, 'contradictory')
        assert.equal(error.evidence.observedExecutable, executable)
        return true
      },
    )
  }
})

test('Linux rewritten single-field cmdline retains OS fields without inventing an argv vector', async () => {
  const text = 'browser executable --user-data-dir=' + taskRoot + '/tmp/p ' + requested.join(' ')
  const raw = Buffer.from(text + '\0')
  const result = await boundary({ raw }).observe({ acceptance: true, requestedHeadless: false })
  assert.equal(result.observedArguments, null)
  assert.deepEqual(result.observedCommandLineFields, [text])
  assert.equal(result.rawCommandLineBase64, raw.toString('base64'))
  assert.equal(result.rawObservedCommandLine, text + '\0')
  assert.match(result.argumentRepresentation, /rewritten.*original argv boundaries.*unknown/)
  assert.equal(result.environment.headless, false)
  assert.equal(result.acceptanceModeGuard, 'passed-headed')
})

test('shared acceptance-request guard is usable before any browser factory is invoked', () => {
  assert.doesNotThrow(() =>
    assertBrowserAcceptanceRequest({
      acceptance: true,
      requestedHeadless: false,
      requestedArguments: requested,
    }),
  )
  for (const requestedHeadless of [true, undefined]) {
    assert.throws(
      () =>
        assertBrowserAcceptanceRequest({
          acceptance: true,
          requestedHeadless,
          requestedArguments: requested,
        }),
      /explicitly headed launch request/,
    )
  }
  assert.throws(
    () =>
      assertBrowserAcceptanceRequest({
        acceptance: true,
        requestedHeadless: false,
        requestedArguments: requested.concat(['--headless=new']),
      }),
    /explicitly headed launch request/,
  )
  assert.doesNotThrow(() =>
    assertBrowserAcceptanceRequest({
      acceptance: false,
      requestedHeadless: true,
      requestedArguments: requested.concat(['--headless=new']),
    }),
  )
})

test('Linux rewritten fields enforce the same owned profile and exact rendered flag gates', async () => {
  for (const [suffix, reason] of [
    ['--user-data-dir=' + join(tmpdir(), 'foreign') + ' ' + requested.join(' '), /task-owned/],
    [
      '--user-data-dir=' + taskRoot + '/tmp/p ' + requested[0] + ' --max-active-webgl-contexts=320',
      /argument missing/,
    ],
    [
      '--user-data-dir=' +
        taskRoot +
        '/tmp/p --user-data-dir=' +
        taskRoot +
        '/tmp/q ' +
        requested.join(' '),
      /Exactly one observed/,
    ],
  ]) {
    const raw = Buffer.from('browser ' + suffix + '\0')
    await assert.rejects(boundary({ raw }).observe(), reason)
  }
  const raw = Buffer.from(
    'browser --user-data-dir=' + taskRoot + '/tmp/p ' + requested.join(' ') + ' --headless=new\0',
  )
  await assert.rejects(
    boundary({ raw }).observe({ acceptance: true, requestedHeadless: false }),
    (error) => {
      assert.equal(error.evidence.environment.headless, true)
      assert.equal(error.evidence.environment.launchMode, 'contradictory')
      assert.equal(error.evidence.observedArguments, null)
      return true
    },
  )
  const root = taskRoot + ' with spaces'
  await assert.rejects(boundary({ root, raw }).observe(), /whitespace-free/)
})

test('rendered profile whitespace ambiguity fails closed without returning a truncated profile', async () => {
  const text =
    'browser --user-data-dir=' + taskRoot + '/tmp/profile with spaces ' + requested.join(' ')
  await assert.rejects(
    boundary({ platform: 'darwin', rawMac: text }).observe({
      acceptance: true,
      requestedHeadless: false,
    }),
    /profile boundary is ambiguous/,
  )
  await assert.rejects(
    boundary({ raw: Buffer.from(text + '\0') }).observe({
      acceptance: true,
      requestedHeadless: false,
    }),
    /profile boundary is ambiguous/,
  )
})

test('observed flag tokens come from OS evidence with explicit representation qualification', async () => {
  const extra = '--use-angle=gl'
  const argv = ['browser', '--user-data-dir=' + taskRoot + '/tmp/p'].concat(requested, [extra])
  for (const options of [
    { argv },
    { argv, raw: Buffer.from(argv.join(' ') + '\0') },
    { argv, platform: 'darwin' },
  ]) {
    const result = await boundary(options).observe()
    assert.deepEqual(result.observedFlagTokens, argv.slice(1))
    assert(!result.requestedArguments.includes(extra))
    assert.equal(result.originalExecveArguments, null)
    const qualification = result.observedFlagTokensQualification
    if (result.observedArguments === null) {
      assert.match(qualification, /whitespace tokens.*original argv boundaries.*unavailable/)
      continue
    }
    assert.match(qualification, /NUL-delimited current OS fields/)
  }
})

for (const platform of ['linux', 'darwin']) {
  test(`${platform} actual HeadlessChrome user agent rejects acceptance even with a Chrome product`, async () => {
    const version = { product, userAgent: 'Mozilla/5.0 HeadlessChrome/154.0.8037.93 Safari/537.36' }
    const external = boundary({ platform, version })
    await assert.rejects(
      external.observe({ acceptance: true, requestedHeadless: false }),
      (error) => {
        assert.equal(error.code, 'BROWSER_ACCEPTANCE_REQUIRES_HEADED')
        assert.equal(error.evidence.environment.headless, true)
        assert.equal(error.evidence.environment.launchMode, 'contradictory')
        assert.deepEqual(error.evidence.browserVersion, version)
        return true
      },
    )
  })
}

for (const platform of ['linux', 'darwin']) {
  test(`${platform} complete actual version metadata still qualifies headed acceptance`, async () => {
    const version = { product, userAgent: 'Mozilla/5.0 Chrome/154.0.8037.93 Safari/537.36' }
    const result = await boundary({ platform, version }).observe({
      acceptance: true,
      requestedHeadless: false,
    })
    assert.equal(result.acceptanceModeGuard, 'passed-headed')
    assert.equal(result.environment.headless, false)
    assert.equal(result.environment.launchMode, 'headed')
    assert.deepEqual(result.browserVersion, version)
  })

  for (const [name, version] of [
    ['missing', { product }],
    ['empty', { product, userAgent: '' }],
    ['null', { product, userAgent: null }],
    ['numeric', { product, userAgent: 42 }],
    ['whitespace-only', { product, userAgent: ' \r\n\t' }],
  ]) {
    test(`${platform} ${name} actual user agent rejects before process observation`, async () => {
      const external = boundary({ platform, version })
      await assert.rejects(
        external.observe({ acceptance: true, requestedHeadless: false }),
        /Actual browser user agent must be non-empty text/,
      )
      assert.deepEqual(external.calls, ['Browser.getVersion'])
    })
  }
}

for (const flag of [
  '--headless=new\nunexpected',
  '--headless=unexpected\rvalue',
  '--headless=new\n',
  '--headless=old\r\n',
]) {
  test(`request guard rejects multiline headless value ${JSON.stringify(flag)} before launch`, () => {
    assert.throws(
      () =>
        assertBrowserAcceptanceRequest({
          acceptance: true,
          requestedHeadless: false,
          requestedArguments: [flag],
        }),
      (error) => error.code === 'BROWSER_ACCEPTANCE_REQUIRES_HEADED',
    )
  })

  test(`Linux multiline observed headless value ${JSON.stringify(flag)} remains unknown`, async () => {
    const argv = ['browser', '--user-data-dir=' + taskRoot + '/tmp/p'].concat(requested, [flag])
    const raw = Buffer.from(argv.join('\0') + '\0')
    const diagnostic = await boundary({ argv, raw }).observe({ requestedHeadless: false })
    assert.equal(diagnostic.environment.headless, null)
    assert.equal(diagnostic.environment.launchMode, 'unknown')
    assert.deepEqual(diagnostic.observedArguments, argv)
    assert(diagnostic.observedFlagTokens.includes(flag))
    assert.equal(diagnostic.rawCommandLineBase64, raw.toString('base64'))
    await assert.rejects(
      boundary({ argv, raw }).observe({ acceptance: true, requestedHeadless: false }),
      (error) => {
        assert.equal(error.code, 'BROWSER_ACCEPTANCE_REQUIRES_HEADED')
        assert.equal(error.evidence.environment.headless, null)
        assert.equal(error.evidence.environment.launchMode, 'unknown')
        assert.equal(error.evidence.rawCommandLineBase64, diagnostic.rawCommandLineBase64)
        return true
      },
    )
  })
}

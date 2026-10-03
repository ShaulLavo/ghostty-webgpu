import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, readlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

export class BrowserProvenanceError extends Error {
  constructor(code, message, evidence) {
    super(message)
    this.name = 'BrowserProvenanceError'
    this.code = code
    this.evidence = evidence
  }
}

function headlessFlag(argument) {
  return (
    argument === '--headless' ||
    argument.startsWith('--headless=') ||
    argument === '--ozone-platform=headless'
  )
}

function observedEnvironment(browserVersion, tokens, requestedHeadless, executable) {
  const unknown = tokens.some(
    (arg) =>
      headlessFlag(arg) &&
      !['--headless', '--headless=new', '--headless=old', '--ozone-platform=headless'].includes(
        arg,
      ),
  )
  const headless =
    browserVersion.product.startsWith('HeadlessChrome/') ||
    /\bHeadlessChrome\//.test(browserVersion.userAgent) ||
    tokens.some(headlessFlag) ||
    /(?:^|\/)(?:chrome-headless-shell|headless_shell)(?: \(deleted\))?$/.test(executable ?? '')
  let launchMode = headless ? 'headless' : 'headed'
  if (unknown) launchMode = 'unknown'
  if (!unknown && typeof requestedHeadless === 'boolean' && requestedHeadless !== headless)
    launchMode = 'contradictory'
  return {
    headless: unknown ? null : headless,
    launchMode,
    requestedHeadless: requestedHeadless ?? null,
  }
}

function positivePid(value) {
  assert(Number.isSafeInteger(value) && value > 0, 'Observed process PID must be valid')
  return value
}

function parseParentPid(raw) {
  assert(typeof raw === 'string' && /^\s*\d+\s*$/.test(raw), 'Observed parent PID must be numeric')
  return positivePid(Number(raw.trim()))
}

async function linuxIdentity(browserPid, read) {
  const raw = await read(`/proc/${browserPid}/stat`, 'utf8')
  assert(typeof raw === 'string', 'Linux process identity must be text')
  assert.equal(
    Number(raw.slice(0, raw.indexOf(' '))),
    browserPid,
    'Linux process identity PID mismatch',
  )
  const open = raw.indexOf('(')
  const close = raw.lastIndexOf(')')
  assert(open > 0 && close > open, 'Linux process identity must contain its command field')
  const fields = raw
    .slice(close + 1)
    .trim()
    .split(/\s+/)
  assert(/^[A-Za-z]$/.test(fields[0]), 'Linux process state is unavailable')
  assert(
    /^\d+$/.test(fields[19]) && BigInt(fields[19]) > 0n,
    'Linux process start time is unavailable',
  )
  return { parentPid: parseParentPid(fields[1]), startTimeTicks: fields[19] }
}

async function observeProcess(
  browserPid,
  ownerPid,
  platform,
  command,
  read,
  readLink,
  timeoutMilliseconds,
) {
  if (platform === 'linux') {
    const before = await linuxIdentity(browserPid, read)
    assert.equal(before.parentPid, ownerPid, 'Chrome must be a direct child before argv is read')
    const raw = await read(`/proc/${browserPid}/cmdline`)
    const executable = await readLink(`/proc/${browserPid}/exe`)
    assert(
      typeof executable === 'string' && isAbsolute(executable),
      'Observed Linux executable must be an absolute path',
    )
    const after = await linuxIdentity(browserPid, read)
    assert.deepEqual(
      after,
      before,
      'Owned browser lifetime and parent must survive argv observation',
    )
    assert(
      Buffer.isBuffer(raw) && raw.length > 1 && raw.at(-1) === 0,
      'Linux argv must be NUL-terminated bytes',
    )
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
    const argv = text.slice(0, -1).split('\0')
    assert(argv[0].length > 0, 'Observed executable must be present')
    const rewritten = argv.length === 1
    return {
      source:
        'Linux /proc/<owned-CDP-browser-PID>/cmdline and exe, bounded by matching parent and start time',
      before,
      after,
      tokens: rewritten ? argv[0].trim().split(/\s+/) : argv,
      observedArguments: rewritten ? null : argv,
      observedCommandLineFields: argv,
      observedExecutable: executable,
      observedArgv0: rewritten ? null : argv[0],
      rawObservedCommandLine: text,
      rawCommandLineBase64: raw.toString('base64'),
      argumentRepresentation: rewritten
        ? 'Single rewritten OS cmdline field; original argv boundaries are unknown'
        : 'NUL-delimited current OS cmdline fields; original execve argv is unobserved',
    }
  }
  const options = { encoding: 'utf8', timeout: timeoutMilliseconds, killSignal: 'SIGKILL' }
  const parent = async () =>
    parseParentPid((await command('ps', ['-p', String(browserPid), '-o', 'ppid='], options)).stdout)
  const before = { parentPid: await parent() }
  assert.equal(before.parentPid, ownerPid, 'Chrome must be a direct child before argv is read')
  const { stdout: raw } = await command(
    'ps',
    ['-ww', '-p', String(browserPid), '-o', 'args='],
    options,
  )
  const after = { parentPid: await parent() }
  assert.deepEqual(after, before, 'Owned browser parent must survive argv observation')
  assert(
    typeof raw === 'string' && raw.trim().length > 0 && !raw.includes('\0'),
    'macOS process command line is unavailable',
  )
  return {
    source: 'macOS ps -ww -o args= for the CDP-identified directly owned Chrome PID',
    before,
    after,
    tokens: raw.trim().split(/\s+/),
    observedArguments: null,
    observedCommandLineFields: null,
    observedExecutable: null,
    observedArgv0: null,
    rawObservedCommandLine: raw,
    rawCommandLineBase64: null,
    argumentRepresentation:
      'Whitespace-delimited ps rendering; original argv boundaries and executable are unknown',
  }
}

export function assertBrowserAcceptanceRequest({
  acceptance = false,
  requestedHeadless,
  requestedArguments,
}) {
  assert(typeof acceptance === 'boolean', 'Acceptance intent must be explicit')
  assert(
    requestedHeadless === undefined || typeof requestedHeadless === 'boolean',
    'Requested headless mode must be a boolean',
  )
  assert(Array.isArray(requestedArguments), 'Requested launch arguments must be an array')
  assert(
    requestedArguments.every(
      (arg) => typeof arg === 'string' && arg.startsWith('--') && !arg.includes('\0'),
    ),
    'Exact requested flag tokens required',
  )
  if (!acceptance || (requestedHeadless === false && !requestedArguments.some(headlessFlag))) return
  throw new BrowserProvenanceError(
    'BROWSER_ACCEPTANCE_REQUIRES_HEADED',
    'Acceptance requires an explicitly headed launch request',
    {
      status: 'rejected-request',
      acceptanceModeGuard: 'rejected',
      requestedArguments: requestedArguments.slice(),
      environment: {
        headless: null,
        launchMode: 'unknown',
        requestedHeadless: requestedHeadless ?? null,
      },
    },
  )
}

export async function observeOwnedBrowserProvenance({
  session,
  taskRoot,
  requestedArguments,
  expectedProduct,
  requestedHeadless,
  acceptance = false,
  ownerPid = process.pid,
  platform = process.platform,
  command = execute,
  read = readFile,
  readLink = readlink,
  timeoutMilliseconds = 2000,
}) {
  if (platform !== 'linux' && platform !== 'darwin') {
    throw new BrowserProvenanceError(
      'BROWSER_PROVENANCE_UNSUPPORTED',
      'Process provenance is unsupported on this platform; ownership and launch mode are unknown',
      {
        status: 'unsupported',
        qualified: false,
        platform,
        environment: {
          headless: null,
          launchMode: 'unknown',
          requestedHeadless: requestedHeadless ?? null,
        },
      },
    )
  }
  positivePid(ownerPid)
  assert(
    typeof taskRoot === 'string' && isAbsolute(taskRoot) && taskRoot.split('/').some(Boolean),
    'Absolute task-owned root required',
  )
  assert(
    !taskRoot.split('/').some((part) => part === '.' || part === '..'),
    'Task root must have canonical segments',
  )
  assertBrowserAcceptanceRequest({ acceptance, requestedHeadless, requestedArguments })
  const requested = requestedArguments.slice()
  assert(
    typeof expectedProduct === 'string' &&
      /^(?:Chrome|HeadlessChrome)\/\d+\.\d+\.\d+\.\d+$/.test(expectedProduct),
    'Expected Chrome product and build required',
  )
  assert(
    Number.isFinite(timeoutMilliseconds) && timeoutMilliseconds > 0,
    'Positive command timeout required',
  )
  if (platform === 'darwin') {
    assert(
      !/\s/.test(taskRoot) && requested.every((arg) => !/\s/.test(arg)),
      'macOS ps provenance requires whitespace-free task roots and requested flags',
    )
  }

  const browserVersion = await session.send('Browser.getVersion')
  assert.equal(browserVersion.product, expectedProduct, 'Actual browser product/build must match')
  assert(
    typeof browserVersion.userAgent === 'string' && browserVersion.userAgent.trim().length > 0,
    'Actual browser user agent must be non-empty text',
  )
  const { processInfo } = await session.send('SystemInfo.getProcessInfo')
  assert(Array.isArray(processInfo), 'CDP process snapshot required')
  const browsers = processInfo.filter(
    (entry) => typeof entry.type === 'string' && entry.type.toLowerCase() === 'browser',
  )
  assert.equal(
    browsers.length,
    1,
    'Exactly one browser process in this owned CDP session is required',
  )
  const browserPid = positivePid(browsers[0].id)
  const observation = await observeProcess(
    browserPid,
    ownerPid,
    platform,
    command,
    read,
    readLink,
    timeoutMilliseconds,
  )
  if (observation.observedArguments === null) {
    assert(
      !/\s/.test(taskRoot) && requested.every((arg) => !/\s/.test(arg)),
      'Rendered command-line provenance requires whitespace-free task roots and requested flags',
    )
  }
  const profiles = observation.tokens.filter(
    (arg) => arg === '--user-data-dir' || arg.startsWith('--user-data-dir='),
  )
  assert.equal(profiles.length, 1, 'Exactly one observed Chrome profile is required')
  assert(
    profiles[0].startsWith('--user-data-dir='),
    'Observed profile must use the --user-data-dir= token',
  )
  if (observation.observedArguments === null) {
    const next = observation.tokens[observation.tokens.indexOf(profiles[0]) + 1]
    assert(
      next === undefined || next.startsWith('--'),
      'Rendered profile boundary is ambiguous; original profile path is unknown',
    )
  }
  const observedProfile = profiles[0].slice('--user-data-dir='.length)
  const profilePrefix = join(taskRoot, 'tmp') + '/'
  assert(
    observedProfile.startsWith(profilePrefix) &&
      observedProfile.length > profilePrefix.length &&
      !observedProfile.split('/').some((part) => part === '.' || part === '..'),
    'Observed task-owned Chrome profile required',
  )
  for (const argument of requested)
    assert(
      observation.tokens.includes(argument),
      'Requested benchmark argument missing from owned process',
    )
  const { tokens, ...evidence } = observation
  const environment = observedEnvironment(
    browserVersion,
    tokens,
    requestedHeadless,
    observation.observedExecutable,
  )
  const result = {
    status: 'observed-owned-process',
    browserVersion,
    browserPid,
    ownerPid,
    observedParentPid: observation.before.parentPid,
    observedProfile,
    originalExecveArguments: null,
    observedFlagTokens: tokens.filter((argument) => argument.startsWith('--')),
    observedFlagTokensQualification:
      observation.observedArguments === null
        ? 'Exact whitespace tokens in observed OS rendering; original argv boundaries are unavailable'
        : 'Exact NUL-delimited current OS fields; original execve arguments are unobserved',
    profileRepresentation:
      observation.observedArguments === null
        ? 'Whitespace-delimited observed profile token; original argument boundaries are unavailable'
        : 'Exact current OS cmdline field',
    requestedFlagQualification:
      observation.observedArguments === null
        ? 'Exact whitespace-token presence in observed OS command-line rendering; original argv unavailable'
        : 'Exact observed NUL-delimited OS field presence',
    profileContainment:
      'Lexical taskRoot/tmp descendant; callers retain filesystem/profile custody gates',
    requestedArguments: requested,
    requestedArgumentsQualification:
      'Requested launch provenance; observed process command line retained independently',
    environment,
    launchModeSource:
      'Actual Browser.getVersion product/userAgent, observed OS headless flags and Linux executable; requested mode is compared independently',
    acceptanceModeGuard: acceptance ? 'passed-headed' : 'not-requested',
    cdpBrowserCommandLine: {
      status: 'NOT_QUERIED_AUTOMATION_DEPENDENT',
      invoked: false,
      reason:
        'Browser.getBrowserCommandLine requires --enable-automation; this observer leaves launch flags unchanged',
    },
    ...evidence,
  }
  if (acceptance && environment.launchMode !== 'headed') {
    result.acceptanceModeGuard = 'rejected'
    throw new BrowserProvenanceError(
      'BROWSER_ACCEPTANCE_REQUIRES_HEADED',
      'Acceptance requires observed headed mode with consistent launch provenance',
      result,
    )
  }
  return result
}

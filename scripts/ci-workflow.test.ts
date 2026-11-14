import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
const workflow = record(Bun.YAML.parse(source))
const jobs = record(workflow.jobs)
const verify = record(jobs.verify)
const browsers = record(jobs['browser-tests'])
const gate = record(jobs.browser)
const codeChanged = "needs.verify.outputs.code == 'true'"

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a workflow mapping')
  return value as Record<string, unknown>
}

function steps(job: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(job.steps)) throw new Error('Expected workflow steps')
  return job.steps.map(record)
}

function step(job: Record<string, unknown>, name: string): Record<string, unknown> {
  const found = steps(job).find((entry) => entry.name === name)
  if (!found) throw new Error(`Missing step: ${name}`)
  return found
}

test('runs every engine across all four shards without cancelling peers or tolerating failures', () => {
  const strategy = record(browsers.strategy)
  expect(strategy.matrix).toEqual({
    engine: ['chromium', 'firefox', 'webkit'],
    shard: [1, 2, 3, 4],
  })
  expect(strategy['fail-fast']).toBe(false)
  expect(browsers['continue-on-error']).toBeUndefined()
  expect(browsers.needs).toBe('verify')
  expect(browsers.if).toBe(
    "${{ (github.event_name != 'pull_request' || !github.event.pull_request.draft) }}",
  )
  expect(record(browsers.env).GHOSTTY_BROWSER_ENGINE).toBe('${{ matrix.engine }}')
  expect(browsers.name).toBe('browser tests (${{ matrix.engine }}, ${{ matrix.shard }}/4)')
  const run = step(browsers, 'Browser tests')
  expect(run.if).toBe(codeChanged)
  expect(steps(browsers).every((entry) => entry['continue-on-error'] === undefined)).toBe(true)
})

test('the browser shell supplies Xvfb only to Firefox and preserves the shard and failures', () => {
  const run = step(browsers, 'Browser tests')
  expect(run.shell).toBe('bash')
  if (typeof run.run !== 'string') throw new Error('Missing browser test shell')
  const command = run.run.replaceAll('${{ matrix.shard }}', '2')
  const stubs = `
function bun() { printf 'bun'; printf ' <%s>' "$@"; printf '\\n'; return "$BROWSER_EXIT_CODE"; }
function xvfb-run() { printf 'xvfb-run <%s>\\n' "$1"; shift; "$@"; }
`
  for (const engine of ['chromium', 'firefox', 'webkit']) {
    for (const exitCode of [0, 23]) {
      const result = spawnSync('bash', ['-c', stubs + command], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          GHOSTTY_BROWSER_ENGINE: engine,
          BROWSER_EXIT_CODE: String(exitCode),
        },
      })
      expect(result.status, result.stderr).toBe(exitCode)
      const prefix = engine === 'firefox' ? 'xvfb-run <-a>\n' : ''
      expect(result.stdout).toBe(prefix + 'bun <run> <test:browser> <--shard=2/4>\n')
    }
  }
})

test('all engines consume the verified build without rebuilding packages', () => {
  const entries = steps(browsers)
  const download = entries.findIndex((entry) => record(entry.with ?? {}).name === 'verified-build')
  const restore = entries.indexOf(step(browsers, 'Verify the build artifact identity and outputs'))
  const run = entries.indexOf(step(browsers, 'Browser tests'))
  expect(download).toBeGreaterThanOrEqual(0)
  expect(restore).toBeGreaterThan(download)
  expect(run).toBeGreaterThan(restore)
  expect(entries[download]?.if).toBe(codeChanged)
  expect(entries[restore]?.run).toBe('bun scripts/verified-build-artifact.ts verify')
  expect(entries[restore]?.if).toBe(codeChanged)
  expect(
    entries.some((entry) => /bun run (?:build|verify:extensions)/.test(String(entry.run))),
  ).toBe(false)
  expect(step(verify, 'Check browser CI coverage and required gates').run).toBe(
    'bun test scripts/ci-workflow.test.ts',
  )
})

test('the selected engine uses the pinned image and validates its own dependencies', () => {
  const image = record(verify.container).image
  expect(image).toMatch(/^mcr\.microsoft\.com\/playwright@sha256:[a-f0-9]{64}$/)
  expect(record(browsers.container).image).toBe(image)
  expect(record(record(jobs.sites).container).image).toBe(image)
  const manifest = record(
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')),
  )
  expect(source).toContain(`# v${record(manifest.devDependencies).playwright}-noble, amd64`)
  expect(step(browsers, 'Validate Playwright system dependencies').run).toContain(
    'playwright install-deps --dry-run "$GHOSTTY_BROWSER_ENGINE"',
  )
  expect(step(browsers, 'Install the selected Playwright browser').run).toContain(
    'playwright install "$GHOSTTY_BROWSER_ENGINE"',
  )
})

test('protected check names run even after a dependency fails or is skipped', () => {
  expect(gate.name).toBe('browser (${{ matrix.shard }}/4)')
  expect(record(gate.strategy)['fail-fast']).toBe(false)
  expect(record(gate.strategy).matrix).toEqual({ shard: [1, 2, 3, 4] })
  expect(gate.needs).toEqual(['verify', 'browser-tests'])
  expect(gate.if).toBe(
    "${{ always() && (github.event_name != 'pull_request' || !github.event.pull_request.draft) }}",
  )
  expect(gate['continue-on-error']).toBeUndefined()
  expect(steps(gate)).toHaveLength(1)
  expect(steps(gate)[0]?.if).toBeUndefined()
  expect(steps(gate)[0]?.['continue-on-error']).toBeUndefined()
})

test('the actual protected gate shell accepts only successful verify and browser jobs', () => {
  const check = step(gate, 'Require every browser engine and shard to pass')
  expect(check.env).toEqual({
    VERIFY_RESULT: '${{ needs.verify.result }}',
    BROWSER_RESULT: '${{ needs.browser-tests.result }}',
  })
  if (typeof check.run !== 'string') throw new Error('Missing gate shell')
  const states = ['success', 'failure', 'cancelled', 'skipped']
  const pairs = states.flatMap((verify) => states.map((browser) => ({ verify, browser })))
  for (const pair of pairs) {
    const result = spawnSync('bash', ['-c', check.run], {
      env: { PATH: process.env.PATH, VERIFY_RESULT: pair.verify, BROWSER_RESULT: pair.browser },
      encoding: 'utf8',
    })
    expect(result.error).toBeUndefined()
    expect(result.status === 0, JSON.stringify(pair)).toBe(
      pair.verify === 'success' && pair.browser === 'success',
    )
  }
})

test('tag releases still wait on verify, protected browser checks, and sites', () => {
  const release = record(jobs.release)
  expect(release.needs).toEqual(['verify', 'browser', 'sites'])
  expect(release.if).toBe("startsWith(github.ref, 'refs/tags/v')")
  expect(step(release, 'Publish tested packages as a GitHub release').run).toContain('--draft')
})

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  BROWSER_ENGINES,
  discoverBrowserTestFiles,
  engineInvocation,
  selectShardFiles,
} from './browser-shard.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
const workflow = record(Bun.YAML.parse(source))
const jobs = record(workflow.jobs)
const verify = record(jobs.verify)
const browser = record(jobs.browser)
const sites = record(jobs.sites)
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

test('protected browser shards run directly without an extra gate stage or error suppression', () => {
  expect(jobs['browser-tests']).toBeUndefined()
  const strategy = record(browser.strategy)
  expect(strategy.matrix).toEqual({ shard: [1, 2, 3, 4] })
  expect(strategy['fail-fast']).toBe(false)
  expect(browser['continue-on-error']).toBeUndefined()
  expect(browser.needs).toBe('verify')
  expect(browser.if).toBe(
    "${{ (github.event_name != 'pull_request' || !github.event.pull_request.draft) }}",
  )
  expect(browser.name).toBe('browser (${{ matrix.shard }}/4)')
  const run = step(browser, 'Browser tests')
  expect(run.if).toBe(codeChanged)
  expect(run.run).toBe('bun scripts/browser-shard.ts --shard=${{ matrix.shard }}/4')
  expect(steps(browser).every((entry) => entry['continue-on-error'] === undefined)).toBe(true)
})

test('browser shards cover every engine and partition all browser tests without gaps', async () => {
  expect(BROWSER_ENGINES).toEqual(['chromium', 'firefox', 'webkit'])
  const all = await discoverBrowserTestFiles(root)
  expect(all.length).toBeGreaterThan(0)
  const seen: string[] = []
  for (let shard = 1; shard <= 4; shard++) {
    const chunk = selectShardFiles(all, shard, 4)
    expect(chunk.length).toBeGreaterThan(0)
    seen.push(...chunk)
    for (const engine of BROWSER_ENGINES) {
      const invocation = engineInvocation(engine, chunk)
      expect(invocation.env.GHOSTTY_BROWSER_ENGINE).toBe(engine)
      const usesXvfb = invocation.command[0] === 'xvfb-run'
      expect(usesXvfb).toBe(engine === 'firefox')
      expect(invocation.command.slice(-chunk.length)).toEqual(chunk)
    }
  }
  expect(seen.toSorted()).toEqual(all)
})

test('browser shards and sites consume the verified build without rebuilding or installing Zig', () => {
  const entries = steps(browser)
  const download = entries.findIndex((entry) => record(entry.with ?? {}).name === 'verified-build')
  const restore = entries.indexOf(step(browser, 'Verify the build artifact identity and outputs'))
  const run = entries.indexOf(step(browser, 'Browser tests'))
  expect(download).toBeGreaterThanOrEqual(0)
  expect(restore).toBeGreaterThan(download)
  expect(run).toBeGreaterThan(restore)
  expect(entries[download]?.if).toBe(codeChanged)
  expect(entries[restore]?.run).toBe('bun scripts/verified-build-artifact.ts verify')
  expect(entries[restore]?.if).toBe(codeChanged)
  expect(
    entries.some((entry) => /bun run (?:build|verify:extensions)/.test(String(entry.run))),
  ).toBe(false)
  expect(entries.some((entry) => String(entry.uses ?? '').includes('setup-zig'))).toBe(false)
  expect(steps(sites).some((entry) => String(entry.uses ?? '').includes('setup-zig'))).toBe(false)
  expect(step(verify, 'Check browser CI coverage and required gates').run).toBe(
    'bun test scripts/ci-workflow.test.ts',
  )
})

test('all browser engines use the pinned Playwright image and validate their dependencies', () => {
  const image = record(verify.container).image
  expect(image).toMatch(/^mcr\.microsoft\.com\/playwright@sha256:[a-f0-9]{64}$/)
  expect(record(browser.container).image).toBe(image)
  expect(record(sites.container).image).toBe(image)
  const manifest = record(
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')),
  )
  expect(source).toContain(`# v${record(manifest.devDependencies).playwright}-noble, amd64`)
  expect(step(browser, 'Validate Playwright system dependencies').run).toContain(
    'playwright install-deps --dry-run chromium firefox webkit',
  )
  expect(step(browser, 'Install Playwright browsers').run).toContain(
    'playwright install chromium firefox webkit',
  )
})

test('tag releases still wait on verify, protected browser checks, and sites', () => {
  const release = record(jobs.release)
  expect(release.needs).toEqual(['verify', 'browser', 'sites'])
  expect(release.if).toBe("startsWith(github.ref, 'refs/tags/v')")
  expect(step(release, 'Publish tested packages as a GitHub release').run).toContain('--draft')
})

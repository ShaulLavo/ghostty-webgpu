import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  BROWSER_ENGINES,
  discoverBrowserTestFiles,
  engineInvocation,
  partitionSlices,
  runBrowserShard,
} from './browser-shard.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
const workflow = record(Bun.YAML.parse(source))
const jobs = record(workflow.jobs)
const verify = record(jobs.verify)
const codeChanged = "github.event_name != 'pull_request' || steps.paths.outputs.code == 'true'"

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

test('CI runs every required check in one verify job with no error suppression', () => {
  expect(Object.keys(jobs).toSorted()).toEqual(['release', 'verify'])
  expect(verify['continue-on-error']).toBeUndefined()
  const run = step(verify, 'Browser tests')
  expect(run.if).toBe(codeChanged)
  expect(run.run).toBe('bun scripts/browser-shard.ts --shard=1/1 --slices=6 --workers=3')
  expect(step(verify, 'Verify both docs sites, examples and search').run).toBe(
    'bun run sites:verify "$PWD/.artifacts/docs-browser" 4327',
  )
  expect(steps(verify).every((entry) => entry['continue-on-error'] === undefined)).toBe(true)
})

test('browser runner covers every engine and propagates failures across all slices', async () => {
  expect(BROWSER_ENGINES).toEqual(['chromium', 'firefox', 'webkit'])
  const all = await discoverBrowserTestFiles(root)
  expect(all.length).toBeGreaterThan(0)
  const slices = partitionSlices(all, 6)
  const combined = slices.reduce<string[]>((acc, slice) => acc.concat(slice), [])
  expect(combined.toSorted()).toEqual(all)
  for (const engine of BROWSER_ENGINES) {
    const invocation = engineInvocation(engine, all)
    expect(invocation.env.GHOSTTY_BROWSER_ENGINE).toBe(engine)
    expect(invocation.command[0] === 'xvfb-run').toBe(engine === 'firefox')
    expect(invocation.command.slice(-all.length)).toEqual(all)
  }
  const executed = new Set<string>()
  const outcome = await runBrowserShard({
    cwd: root,
    index: 1,
    total: 1,
    slices: 6,
    workers: 3,
    files: all,
    cacheRoot: '/tmp/ci-workflow-browser-check',
    log: () => {},
    runner: async (invocation, meta) => {
      executed.add(`${invocation.engine}:${meta.sliceIndex}`)
      return {
        exitCode: invocation.engine === 'webkit' && meta.sliceIndex === 0 ? 1 : 0,
        output: '',
      }
    },
  })
  expect(outcome.exitCode).toBe(1)
  expect(executed.size).toBe(slices.length * BROWSER_ENGINES.length)
})

test('verify builds once, keeps site TypeDoc builds serial, and runs workflow self-checks', () => {
  const entries = steps(verify)
  const build = entries.indexOf(step(verify, 'Build and check all packages'))
  const sitesBuild = entries.indexOf(
    step(verify, 'Build both sites and dry-run the Worker from the verified packages'),
  )
  const sitesVerify = entries.indexOf(step(verify, 'Verify both docs sites, examples and search'))
  const browserRun = entries.indexOf(step(verify, 'Browser tests'))
  expect(build).toBeGreaterThanOrEqual(0)
  expect(sitesBuild).toBeGreaterThan(build)
  expect(sitesVerify).toBeGreaterThan(sitesBuild)
  expect(browserRun).toBeGreaterThan(build)
  const sitesBuildScript = String(entries[sitesBuild]?.run)
  expect(entries[sitesBuild]?.shell).toBe('bash')
  expect(sitesBuildScript).toContain('set -euo pipefail')
  expect(sitesBuildScript).not.toContain('&')
  expect(step(verify, 'Check browser CI coverage and required gates').run).toBe(
    'bun test scripts/ci-workflow.test.ts',
  )
})

test('all browser engines use the pinned Playwright image with 2g /dev/shm and validate dependencies', () => {
  const container = record(verify.container)
  expect(container.image).toMatch(/^mcr\.microsoft\.com\/playwright@sha256:[a-f0-9]{64}$/)
  expect(container.options).toContain('--shm-size=2g')
  const manifest = record(
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')),
  )
  expect(source).toContain(`# v${record(manifest.devDependencies).playwright}-noble, amd64`)
  expect(step(verify, 'Validate Playwright system dependencies').run).toContain(
    'playwright install-deps --dry-run chromium firefox webkit',
  )
  expect(step(verify, 'Install Playwright browsers').run).toContain(
    'playwright install chromium firefox webkit',
  )
})

test('tag releases still wait on verify', () => {
  const release = record(jobs.release)
  expect(release.needs).toEqual(['verify'])
  expect(release.if).toBe("startsWith(github.ref, 'refs/tags/v')")
  expect(step(release, 'Publish tested packages as a GitHub release').run).toContain('--draft')
})

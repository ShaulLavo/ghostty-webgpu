const forwarded = process.argv.slice(2)

interface BrowserRun {
  readonly config: string
  readonly name: string
}

const browserRuns: readonly BrowserRun[] = [
  { config: 'vitest.xterm-chromium.config.ts', name: 'Chromium' },
  { config: 'vitest.xterm-firefox.config.ts', name: 'Firefox' },
  { config: 'vitest.xterm-webkit.config.ts', name: 'WebKit' },
]

class XtermBrowserTestError extends Error {
  constructor(failures: readonly string[]) {
    super(`Cross-browser xterm tests failed: ${failures.join(', ')}`)
    this.name = 'XtermBrowserTestError'
  }
}

async function runVitest(run: BrowserRun): Promise<number> {
  process.stdout.write(`\nRunning xterm compatibility tests in ${run.name}\n`)
  const child = Bun.spawn(['bunx', 'vitest', 'run', '--config', run.config, ...forwarded], {
    stderr: 'inherit',
    stdout: 'inherit',
  })
  return child.exited
}

const failures: string[] = []
for (const run of browserRuns) {
  const exitCode = await runVitest(run)
  if (exitCode === 0) continue
  failures.push(`${run.name} (exit ${exitCode})`)
}

if (failures.length > 0) throw new XtermBrowserTestError(failures)

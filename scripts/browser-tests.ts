const config = 'vitest.browser.config.ts'
const terminalUiTest = 'src/dom/tests/terminal-ui.browser.test.ts'
const wideCellPattern = 'preserves native wide-cell continuation'
const forwarded = process.argv.slice(2)

class BrowserTestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserTestError'
  }
}

async function runVitest(args: readonly string[]): Promise<void> {
  const child = Bun.spawn(['bunx', 'vitest', ...args], {
    stderr: 'inherit',
    stdout: 'inherit',
  })
  const exitCode = await child.exited
  if (exitCode === 0) return
  throw new BrowserTestError(`Vitest exited with status ${exitCode}`)
}

function escapedPattern(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

async function runCiBrowserTests(): Promise<void> {
  await runVitest(['run', '--config', config, '--exclude', terminalUiTest])
  await runVitest([
    'run',
    '--config',
    config,
    terminalUiTest,
    '--testNamePattern',
    `^(?!.*${escapedPattern(wideCellPattern)}).*`,
  ])
  await runVitest(['run', '--config', config, terminalUiTest, '--testNamePattern', wideCellPattern])
}

if (process.env.CI === 'true' && forwarded.length === 0) {
  await runCiBrowserTests()
} else {
  await runVitest(['run', '--config', config, ...forwarded])
}

const config = 'vitest.browser.config.ts'
const rendererTest = 'src/render/tests/renderer.browser.test.ts'
const terminalUiTest = 'src/dom/tests/terminal-ui.browser.test.ts'
const wideCellPattern = 'preserves native wide-cell continuation'
const forwarded = process.argv.slice(2)

interface ListedTest {
  readonly name: string
}

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

async function listRendererTests(): Promise<readonly ListedTest[]> {
  const child = Bun.spawn(['bunx', 'vitest', 'list', '--config', config, rendererTest, '--json'], {
    stderr: 'inherit',
    stdout: 'pipe',
  })
  const output = await new Response(child.stdout).text()
  const exitCode = await child.exited
  if (exitCode !== 0) throw new BrowserTestError(`Vitest list exited with status ${exitCode}`)
  return JSON.parse(output) as ListedTest[]
}

function escapedPattern(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function exactPattern(name: string): string {
  return `^${escapedPattern(name)}$`
}

async function runIsolatedRendererTests(): Promise<void> {
  await runVitest([
    'run',
    '--config',
    config,
    '--exclude',
    rendererTest,
    '--exclude',
    terminalUiTest,
  ])
  await runVitest([
    'run',
    '--config',
    config,
    terminalUiTest,
    '--testNamePattern',
    `^(?!.*${escapedPattern(wideCellPattern)}).*`,
  ])
  await runVitest(['run', '--config', config, terminalUiTest, '--testNamePattern', wideCellPattern])
  const tests = await listRendererTests()
  for (const test of tests) {
    await runVitest([
      'run',
      '--config',
      config,
      rendererTest,
      '--testNamePattern',
      exactPattern(test.name),
    ])
  }
}

if (process.env.CI === 'true' && forwarded.length === 0) {
  await runIsolatedRendererTests()
} else {
  await runVitest(['run', '--config', config, ...forwarded])
}

const config = 'vitest.browser.config.ts'
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

await runVitest(['run', '--config', config, ...forwarded])

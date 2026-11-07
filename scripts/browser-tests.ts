const config = 'vitest.browser.config.ts'
const forwarded = process.argv.slice(2)

class BrowserTestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserTestError'
  }
}

async function runVitest(args: readonly string[]): Promise<void> {
  const child = Bun.spawn(['bunx', 'vitest'].concat(args), {
    stderr: 'inherit',
    stdout: 'inherit',
  })
  const exitCode = await child.exited
  if (exitCode === 0) return
  throw new BrowserTestError(`Vitest exited with status ${exitCode}`)
}

if (forwarded[0] === '--native-ios') {
  const child = Bun.spawn(['node', 'scripts/ios-browser-launch.ts'].concat(forwarded.slice(1)), {
    stderr: 'inherit',
    stdout: 'inherit',
  })
  process.exitCode = await child.exited
} else {
  await runVitest(['run', '--config', config].concat(forwarded))
}

import { GHOSTTY_SOURCE_REVISION } from '../src/core/version.js'

const sourceRevision = GHOSTTY_SOURCE_REVISION

export class ArtifactBuildError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArtifactBuildError'
  }
}

export async function verifyRevision(source: string): Promise<void> {
  const process = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
    cwd: source,
    stderr: 'inherit',
    stdout: 'pipe',
  })
  const revision = (await new Response(process.stdout).text()).trim()
  const exitCode = await process.exited
  if (exitCode !== 0) throw new ArtifactBuildError('Unable to read the Ghostty source revision')
  if (revision === sourceRevision) return
  throw new ArtifactBuildError(`Expected Ghostty ${sourceRevision}, received ${revision}`)
}

export async function verifyCleanSource(source: string): Promise<void> {
  const process = Bun.spawn(['git', 'status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: source,
    stderr: 'inherit',
    stdout: 'pipe',
  })
  const status = (await new Response(process.stdout).text()).trim()
  const exitCode = await process.exited
  if (exitCode !== 0) throw new ArtifactBuildError('Unable to inspect the Ghostty source tree')
  if (status.length === 0) return
  throw new ArtifactBuildError('Ghostty source tree must be clean to build pinned artifacts')
}

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Turbo prepares dependencies before launching this package's build task.
if (process.env.TURBO_HASH) process.exit(0)

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url))
const hotkeysManifest = join(workspaceRoot, 'packages/hotkeys/packages/hotkeys/package.json')
if (!existsSync(hotkeysManifest)) process.exit(0)

const build = Bun.spawn(
  [process.execPath, 'x', '--no-install', 'turbo', 'run', 'build', '--filter=@fregat/hotkeys'],
  { cwd: workspaceRoot, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
)
process.exitCode = await build.exited

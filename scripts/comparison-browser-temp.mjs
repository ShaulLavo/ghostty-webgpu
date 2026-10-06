import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function prepareComparisonBrowserTemp(
  root,
  ipcRoot = process.platform === 'win32' ? tmpdir() : '/tmp',
) {
  const owned = []
  const remove = async () => {
    for (const directory of owned.toReversed())
      await rm(directory, { recursive: true, force: true })
  }
  try {
    await mkdir(root, { recursive: true })
    const directory = await mkdtemp(join(root, 'run-'))
    owned.push(directory)
    const ipc = await mkdtemp(join(ipcRoot, 'b-'))
    owned.push(ipc)
    const temporary = join(ipc, 'd')
    // Chromium binds its singleton socket through this short alias; data stays under root.
    await symlink(directory, temporary, process.platform === 'win32' ? 'junction' : 'dir')
    return { directory, temporary, remove }
  } catch (error) {
    await remove()
    throw error
  }
}

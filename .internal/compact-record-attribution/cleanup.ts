import assert from 'node:assert/strict'
import { readdir, readFile, stat } from 'node:fs/promises'

const scratch = process.argv[2]
assert(scratch && /^\/work\/tmp\/g5\.[A-Za-z0-9]+$/.test(scratch))
const uid = process.getuid?.()
assert(uid !== undefined)
async function owned(pid: string): Promise<boolean> {
  try {
    const metadata = await stat(`/proc/${pid}`)
    if (metadata.uid !== uid || Number(pid) === process.pid) return false
    const command = await readFile(`/proc/${pid}/cmdline`, 'utf8')
    return command.split('\0').some((argument) => argument.includes(scratch + '/'))
  } catch {
    return false
  }
}
async function matching() {
  const entries = (await readdir('/proc')).filter((value) => /^\d+$/.test(value))
  const checks = await Promise.all(
    entries.map(async (pid) => ({ pid: Number(pid), owned: await owned(pid) })),
  )
  return checks.filter((entry) => entry.owned).map((entry) => entry.pid)
}
function signal(pid: number, name: NodeJS.Signals) {
  try {
    process.kill(pid, name)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return
    throw error
  }
}
const before = await matching()
for (const pid of before) signal(pid, 'SIGTERM')
if (before.length) await new Promise((resolve) => setTimeout(resolve, 1000))
const survivors = await matching()
for (const pid of survivors) signal(pid, 'SIGKILL')
if (survivors.length) await new Promise((resolve) => setTimeout(resolve, 100))
const remaining = await matching()
console.log(JSON.stringify({ scratch, terminated: before, killed: survivors, remaining }))
assert.deepEqual(remaining, [])

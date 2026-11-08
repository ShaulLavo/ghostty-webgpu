import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'vitest'
import { combinedControlModes } from './ios-browser-bound-operations-modes.ts'

const entry = fileURLToPath(new URL('./ios-browser-bound-operations-control.ts', import.meta.url))
test.each(combinedControlModes)(
  'combined admitted DOM, official provider and SDK: %s',
  combinedControl,
  55000,
)

async function combinedControl(mode: string): Promise<void> {
  const directory = await mkdtemp('/work/tmp/gb-test-')
  let child: ReturnType<typeof spawn> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let forced: ReturnType<typeof setTimeout> | undefined
  try {
    child = spawn('node', [entry, mode], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TMPDIR: directory,
        GHOSTTY_BOUND_REPORT: directory,
        GHOSTTY_BOUND_SCRATCH: directory,
      },
    })
    let output = ''
    child.stdout?.on('data', (chunk) => {
      output += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      output += String(chunk)
    })
    const pid = child.pid
    timer = setTimeout(() => signal(pid, 'SIGTERM', false), 45000)
    forced = setTimeout(() => signal(pid, 'SIGKILL', true), 50000)
    const [code, received] = await once(child, 'close')
    assert.equal(received, null, output)
    assert.equal(code, 0, output)
    await retainEvidence(directory, mode)
  } finally {
    clearTimeout(timer)
    clearTimeout(forced)
    await stop(child)
    await rm(directory, { recursive: true, force: true })
  }
}

async function retainEvidence(directory: string, mode: string): Promise<void> {
  const evidence: unknown = JSON.parse(await readFile(join(directory, `${mode}.json`), 'utf8'))
  assert(evidence && typeof evidence === 'object' && 'nativeCredit' in evidence)
  assert.equal(evidence.nativeCredit, false)
  const destination = process.env.GHOSTTY_BOUND_EVIDENCE
  if (!destination) return
  await mkdir(destination, { recursive: true })
  await copyFile(join(directory, `${mode}.json`), join(destination, `${mode}.json`))
}

async function stop(child: ReturnType<typeof spawn> | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const closed = once(child, 'close')
  const pid = child.pid
  const forced = setTimeout(() => signal(pid, 'SIGKILL', true), 3000)
  try {
    signal(pid, 'SIGTERM', false)
    await closed
  } finally {
    clearTimeout(forced)
  }
}

function signal(pid: number | undefined, value: NodeJS.Signals, group: boolean): void {
  if (!pid) return
  try {
    process.kill(group ? -pid : pid, value)
  } catch (reason) {
    if (!(reason instanceof Error && 'code' in reason && reason.code === 'ESRCH')) throw reason
  }
}

import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import type { NodeOutcome } from './ios-browser-process.ts'

export type HostSummary = {
  exit: 1 | 2 | 3 | 4
  fileComplete: boolean
  rootBrowserSuiteComplete: false
  framework: 'passed' | 'failed' | 'interrupted' | null
  cleanupConfirmed: boolean
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cleanupStatus(value: unknown): boolean {
  if (!record(value) || !record(value.cleanup)) throw new Error('Missing host cleanup')
  const cleanup = value.cleanup
  return ['session', 'launcher', 'callbacks', 'provider', 'context', 'scratch'].every((key) => {
    const step = cleanup[key]
    if (
      !record(step) ||
      (step.status !== 'confirmed' &&
        step.status !== 'not-created' &&
        step.status !== 'unconfirmed')
    )
      throw new Error(`Invalid host cleanup step: ${key}`)
    return step.status !== 'unconfirmed'
  })
}

function frameworkStatus(value: unknown): HostSummary['framework'] {
  if (value === null) return null
  if (
    !record(value) ||
    (value.status !== 'passed' && value.status !== 'failed' && value.status !== 'interrupted')
  )
    throw new Error('Invalid ordinary framework status')
  return value.status
}

export function parseHostSummary(value: unknown): HostSummary {
  if (
    !record(value) ||
    (value.exit !== 1 && value.exit !== 2 && value.exit !== 3 && value.exit !== 4) ||
    value.rootBrowserSuiteComplete !== false ||
    typeof value.fileComplete !== 'boolean'
  )
    throw new Error('Invalid selected-root host result')
  const framework = frameworkStatus(value.framework)
  if (framework === null && value.exit !== 2) throw new Error('No ordinary framework end status')
  return {
    exit: value.exit,
    fileComplete: value.fileComplete,
    rootBrowserSuiteComplete: false,
    framework,
    cleanupConfirmed: cleanupStatus(value),
  }
}

export function joinedExit(outcome: NodeOutcome, host: HostSummary | null): number {
  if (!outcome.joined || outcome.kind !== 'exited' || outcome.signal !== null) return 2
  if (outcome.code === 2) return 2
  if (outcome.code === 3 && host === null) return 3
  if (host === null || !host.cleanupConfirmed || outcome.code !== host.exit) return 2
  return host.exit
}

export async function launcherReceipt(resultPath: string, outcome: NodeOutcome): Promise<number> {
  let host: HostSummary | null = null
  let resultError: string | null = null
  try {
    const value: unknown = JSON.parse(await readFile(resultPath, 'utf8'))
    host = parseHostSummary(value)
  } catch (error) {
    resultError = String(error)
  }
  const exit = joinedExit(outcome, host)
  const path = `${resultPath}.launcher.json`
  const temporary = `${path}.${process.pid}.tmp`
  try {
    await writeFile(
      temporary,
      JSON.stringify({ exit, outcome, host, resultError }, null, 2) + '\n',
      { flag: 'wx' },
    )
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => {})
  }
  return exit
}

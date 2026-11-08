import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isAbsolute, resolve } from 'node:path'
import { parseHostSummary } from './ios-browser-result.ts'
import { nativeStage } from './ios-browser-stages.ts'
import { isNativeStage, type NativeStage } from './ios-browser-options.ts'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function positive(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function actualBinding(value: unknown): boolean {
  return (
    record(value) &&
    ['windowHandle', 'iframeElementId', 'topUrl', 'testerUrl'].every(
      (key) => typeof value[key] === 'string' && value[key].length > 0,
    )
  )
}

function actualGeometry(value: unknown): boolean {
  if (!record(value) || !record(value.tester) || !record(value.top) || !record(value.iframe))
    return false
  const { tester, top, iframe } = value
  return (
    tester.width === 414 &&
    tester.height === 896 &&
    positive(tester.dpr) &&
    ['width', 'height', 'visualWidth', 'visualHeight', 'scale'].every((key) =>
      positive(top[key]),
    ) &&
    iframe.width === 414 &&
    iframe.height === 896
  )
}

function finalDocument(value: unknown): value is Record<string, unknown> {
  return (
    record(value) &&
    typeof value.doc === 'string' &&
    value.doc.length > 0 &&
    (value.kind === 'orchestrator' || value.kind === 'tester') &&
    typeof value.ackedThrough === 'number' &&
    Number.isSafeInteger(value.ackedThrough) &&
    value.ackedThrough >= 0 &&
    value.ackedThrough === value.acceptedThrough &&
    value.pending === 0 &&
    typeof value.cutoff === 'number' &&
    Number.isFinite(value.cutoff) &&
    value.cutoff >= 0
  )
}

export function verifyNativeStage(stage: NativeStage, result: unknown, receipt: unknown): void {
  const summary = parseHostSummary(result)
  if (
    summary.exit !== 4 ||
    !summary.fileComplete ||
    summary.framework !== 'passed' ||
    !summary.cleanupConfirmed
  )
    throw new Error('Selected file did not complete with sound partial exit 4')
  if (!record(result) || !actualBinding(result.binding) || !actualGeometry(result.geometry))
    throw new Error('Missing actual native binding or geometry')
  if (!Array.isArray(result.failures) || result.failures.length !== 0)
    throw new Error('Recorded native failures remain')
  const documents = result.documents
  if (
    !Array.isArray(documents) ||
    documents.length !== 2 ||
    !documents.every(finalDocument) ||
    documents[0]?.kind === documents[1]?.kind ||
    documents[0]?.doc === documents[1]?.doc
  )
    throw new Error('Missing separately observed ACKs, zero pending, or document cutoffs')
  const cases = result.cases
  const expected = nativeStage(stage).expected
  if (!Array.isArray(cases) || cases.length !== expected.length)
    throw new Error('Wrong selected-file case inventory')
  const sources = new Set<string>()
  const actualIds = new Set<string>()
  for (const row of cases) {
    if (!record(row) || !record(row.expected) || typeof row.expected.sourceKey !== 'string')
      throw new Error('Unrecognized required source identity')
    const sourceKey = row.expected.sourceKey
    const identity = expected.find((item) => item.sourceKey === sourceKey)
    if (
      !identity ||
      row.expected.file !== identity.file ||
      row.expected.fullName !== identity.fullName ||
      row.expected.timeoutMs !== identity.timeoutMs ||
      row.expected.retries !== identity.retries
    )
      throw new Error('Unrecognized required source identity')
    if (
      sources.has(sourceKey) ||
      typeof row.actualId !== 'string' ||
      !row.actualId ||
      actualIds.has(row.actualId) ||
      row.started !== true ||
      !record(row.outcome) ||
      row.outcome.state !== 'pass' ||
      row.outcome.id !== row.actualId ||
      row.outcome.retryCount !== 0
    )
      throw new Error('Missing, repeated, unrun, or failed selected case')
    sources.add(sourceKey)
    actualIds.add(row.actualId)
  }
  if (
    !record(receipt) ||
    receipt.exit !== 4 ||
    !record(receipt.outcome) ||
    receipt.outcome.kind !== 'exited' ||
    receipt.outcome.code !== 4 ||
    receipt.outcome.signal !== null ||
    receipt.outcome.joined !== true
  )
    throw new Error('Outer Node join or exit agreement is missing')
}

export async function verifyNativeFiles(stage: NativeStage, resultPath: string): Promise<void> {
  const result: unknown = JSON.parse(await readFile(resultPath, 'utf8'))
  const receipt: unknown = JSON.parse(await readFile(`${resultPath}.launcher.json`, 'utf8'))
  verifyNativeStage(stage, result, receipt)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const [stage, path] = process.argv.slice(2)
    if (!isNativeStage(stage) || !path || !isAbsolute(path) || process.argv.length !== 4)
      throw new Error(
        'Usage: node scripts/ios-browser-verify.ts synthetic|viewport|bulk-snapshot|font-resources|measurement|write-queue|presentation|scrollbar-async|history|readline-layout|module-mock|font-fixture|font-geometry|canvas-rasterizer|stamp-cache|pixel-damage|mounted-scroll|dom-appearance|ghostty-keymap|mac-keybindings|output-timing|ui-declarations|managed-fallback|worker-write-queue /absolute/result.json',
      )
    await verifyNativeFiles(stage, path)
    console.log(
      JSON.stringify({ stage, selectedFileComplete: true, rootBrowserSuiteComplete: false }),
    )
  } catch (error) {
    console.error(error)
    process.exitCode = 2
  }
}

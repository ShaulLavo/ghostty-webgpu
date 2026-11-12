import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import type { CaptureGeometry } from './ios-browser-capture-geometry.ts'
import { inspectCapturePng } from './ios-browser-capture-png.ts'

export function describeViewport() {
  const view = window.top
  if (!view) throw new Error('Diagnostic requires the top document')
  const visual = view.visualViewport
  const env = document.querySelector('#capture-diagnostic-env')
  const style = env ? getComputedStyle(env) : null
  return {
    innerWidth: view.innerWidth,
    innerHeight: view.innerHeight,
    outerWidth: view.outerWidth,
    outerHeight: view.outerHeight,
    screenX: view.screenX,
    screenY: view.screenY,
    screen: {
      width: view.screen.width,
      height: view.screen.height,
      availWidth: view.screen.availWidth,
      availHeight: view.screen.availHeight,
    },
    documentElement: {
      clientWidth: view.document.documentElement.clientWidth,
      clientHeight: view.document.documentElement.clientHeight,
    },
    visualViewport: visual
      ? {
          offsetLeft: visual.offsetLeft,
          offsetTop: visual.offsetTop,
          pageLeft: visual.pageLeft,
          pageTop: visual.pageTop,
          width: visual.width,
          height: visual.height,
          scale: visual.scale,
        }
      : null,
    scrollX: view.scrollX,
    scrollY: view.scrollY,
    orientation: view.screen.orientation.type,
    safeArea: style ? { paddingTop: style.paddingTop, paddingBottom: style.paddingBottom } : null,
  }
}

export type DiagnosticMetrics = {
  viewport: ReturnType<typeof describeViewport> | null
  windowRect: Awaited<ReturnType<WebdriverIO.Browser['getWindowRect']>> | null
  errors: string[]
}
export type CaptureDiagnostic = { before: CaptureGeometry } & (
  | { kind: 'official-rejected'; rejection: string }
  | {
      kind: 'captured'
      after: CaptureGeometry | null
      raw: Buffer
      outcome: { kind: 'fulfilled' } | { kind: 'rejected'; rejection: string }
      metrics: DiagnosticMetrics
    }
)
export type DiagnosticObservation = { name: string; evidence: CaptureDiagnostic }

export function rejectionMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function readDiagnosticMetrics(
  browser: WebdriverIO.Browser,
): Promise<DiagnosticMetrics> {
  const metrics: DiagnosticMetrics = { viewport: null, windowRect: null, errors: [] }
  try {
    metrics.viewport = await browser.execute(describeViewport)
  } catch (error) {
    metrics.errors.push(rejectionMessage(error))
  }
  try {
    metrics.windowRect = await browser.getWindowRect()
  } catch (error) {
    metrics.errors.push(rejectionMessage(error))
  }
  return metrics
}

function rawMetadata(raw: Buffer) {
  try {
    const info = inspectCapturePng(raw)
    return {
      width: info.width,
      height: info.height,
      colorType: info.colorType,
      profiles: info.profiles,
      chunks: info.chunks.map(({ type }) => type),
    }
  } catch (error) {
    return { inspectionError: rejectionMessage(error) }
  }
}

export async function writeCaptureDiagnostic(
  resultPath: string,
  rows: readonly DiagnosticObservation[],
): Promise<void> {
  if (rows.length !== 1) throw new Error(`Expected one diagnostic attempt, received ${rows.length}`)
  const row = rows[0]!
  if (row.evidence.kind === 'official-rejected') {
    await writeFile(`${resultPath}.diagnostic.json`, JSON.stringify(rows, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    })
    return
  }
  const { raw, ...evidence } = row.evidence
  const sha256 = createHash('sha256').update(raw).digest('hex')
  const path = `${resultPath}.viewport.png`
  await writeFile(path, raw, { flag: 'wx', mode: 0o600 })
  const saved = await readFile(path)
  if (createHash('sha256').update(saved).digest('hex') !== sha256)
    throw new Error('Diagnostic PNG readback hash changed')
  await writeFile(
    `${resultPath}.diagnostic.json`,
    JSON.stringify(
      [
        {
          name: row.name,
          evidence: { ...evidence, raw: { ...rawMetadata(raw), sha256, bytes: raw.length } },
        },
      ],
      null,
      2,
    ) + '\n',
    { flag: 'wx', mode: 0o600 },
  )
}

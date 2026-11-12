import { access, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { verifyNativeSource } from './ios-browser-source.ts'

export type NativeStage =
  | 'synthetic'
  | 'capture-control'
  | 'capture-diagnostic'
  | 'viewport'
  | 'bulk-snapshot'
  | 'font-resources'
  | 'measurement'
  | 'write-queue'
  | 'presentation'
  | 'scrollbar-async'
  | 'history'
  | 'readline-layout'
  | 'module-mock'
  | 'font-fixture'
  | 'font-geometry'
  | 'canvas-rasterizer'
  | 'stamp-cache'
  | 'pixel-damage'
  | 'canvas-theme-cache'
  | 'canvas-zwj'
  | 'pixels'
  | 'glyph-constraints'
  | 'sprites'
  | 'displayed-pixels-fixture'
  | 'canvas-scroll'
  | 'legacy-text'
  | 'pointer-selection'
  | 'hotkeys-focus'
  | 'mounted-scroll'
  | 'dom-appearance'
  | 'ghostty-keymap'
  | 'mac-keybindings'
  | 'output-timing'
  | 'ui-declarations'
  | 'managed-fallback'
  | 'worker-write-queue'
  | 'glyph-fidelity'
  | 'selection-worker-ownership'
  | 'canvas-image'
  | 'displayed-frame-boundaries'
  | 'gpu-textures'
  | 'atlas-registry'
  | 'webgpu'
  | 'shared-atlas'
  | 'selector'
  | 'text-pass'
  | 'renderer-benchmark'
export type NativeOptions = { stage: NativeStage; udid: string; resultPath: string }
export type NativeRequest = { kind: 'help' } | { kind: 'run'; options: NativeOptions }

export class NativePreconditionError extends Error {}

export const nativeUsage =
  'Usage: node scripts/ios-browser-launch.ts --stage synthetic|capture-control|capture-diagnostic|viewport|bulk-snapshot|font-resources|measurement|write-queue|presentation|scrollbar-async|history|readline-layout|module-mock|font-fixture|font-geometry|canvas-rasterizer|stamp-cache|pixel-damage|canvas-theme-cache|canvas-zwj|pixels|glyph-constraints|sprites|displayed-pixels-fixture|canvas-scroll|legacy-text|pointer-selection|hotkeys-focus|mounted-scroll|dom-appearance|ghostty-keymap|mac-keybindings|output-timing|ui-declarations|managed-fallback|worker-write-queue|glyph-fidelity|selection-worker-ownership|canvas-image|displayed-frame-boundaries|gpu-textures|atlas-registry|webgpu|shared-atlas|selector|text-pass|renderer-benchmark --udid <explicit simulator UUID> --result <new absolute .json path>'

export function isNativeStage(value: unknown): value is NativeStage {
  return (
    value === 'synthetic' ||
    value === 'capture-control' ||
    value === 'capture-diagnostic' ||
    value === 'viewport' ||
    value === 'bulk-snapshot' ||
    value === 'font-resources' ||
    value === 'measurement' ||
    value === 'write-queue' ||
    value === 'presentation' ||
    value === 'scrollbar-async' ||
    value === 'history' ||
    value === 'readline-layout' ||
    value === 'module-mock' ||
    value === 'font-fixture' ||
    value === 'font-geometry' ||
    value === 'canvas-rasterizer' ||
    value === 'stamp-cache' ||
    value === 'pixel-damage' ||
    value === 'canvas-theme-cache' ||
    value === 'canvas-zwj' ||
    value === 'pixels' ||
    value === 'glyph-constraints' ||
    value === 'sprites' ||
    value === 'displayed-pixels-fixture' ||
    value === 'canvas-scroll' ||
    value === 'legacy-text' ||
    value === 'pointer-selection' ||
    value === 'hotkeys-focus' ||
    value === 'mounted-scroll' ||
    value === 'dom-appearance' ||
    value === 'ghostty-keymap' ||
    value === 'mac-keybindings' ||
    value === 'output-timing' ||
    value === 'ui-declarations' ||
    value === 'managed-fallback' ||
    value === 'worker-write-queue' ||
    value === 'glyph-fidelity' ||
    value === 'selection-worker-ownership' ||
    value === 'canvas-image' ||
    value === 'displayed-frame-boundaries' ||
    value === 'webgpu' ||
    value === 'shared-atlas' ||
    value === 'selector' ||
    value === 'text-pass' ||
    value === 'renderer-benchmark' ||
    value === 'atlas-registry' ||
    value === 'gpu-textures'
  )
}

export function parseNativeArguments(args: readonly string[]): NativeRequest {
  if (args.length === 1 && args[0] === '--help') return { kind: 'help' }
  if (args.length !== 6) throw new NativePreconditionError(nativeUsage)
  const flags = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!key || !value || !['--stage', '--udid', '--result'].includes(key) || flags.has(key))
      throw new NativePreconditionError(nativeUsage)
    flags.set(key, value)
  }
  const stage = flags.get('--stage')
  const udid = flags.get('--udid')
  const resultPath = flags.get('--result')
  if (!isNativeStage(stage))
    throw new NativePreconditionError(
      'Choose the explicit synthetic, capture-control, capture-diagnostic, viewport, bulk-snapshot, font-resources, measurement, write-queue, presentation, scrollbar-async, history, readline-layout, module-mock, font-fixture, font-geometry, canvas-rasterizer, stamp-cache, pixel-damage, canvas-theme-cache, canvas-zwj, pixels, glyph-constraints, sprites, displayed-pixels-fixture, canvas-scroll, legacy-text, pointer-selection, hotkeys-focus, mounted-scroll, dom-appearance, ghostty-keymap, mac-keybindings, output-timing, ui-declarations, managed-fallback, worker-write-queue, glyph-fidelity, selection-worker-ownership, canvas-image, displayed-frame-boundaries, gpu-textures, atlas-registry, webgpu, shared-atlas, selector, text-pass, or renderer-benchmark stage',
    )
  if (!udid || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(udid))
    throw new NativePreconditionError('An explicit simulator UUID is required')
  if (!resultPath || !isAbsolute(resultPath) || !resultPath.endsWith('.json'))
    throw new NativePreconditionError('Result must be a new absolute .json path')
  return { kind: 'run', options: { stage, udid, resultPath } }
}

export function checkNativeRuntime(runtime: { version: string; platform: string }): void {
  if (runtime.version !== 'v26.12.1')
    throw new NativePreconditionError('The native runner requires Node 26.12.1')
  if (runtime.platform !== 'darwin')
    throw new NativePreconditionError('The parent-owned Safari stage requires macOS')
}

async function requireAbsent(path: string): Promise<void> {
  try {
    await lstat(path)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      return
    throw error
  }
  throw new NativePreconditionError(`Refusing an existing result: ${path}`)
}

export async function nativePreflight(options: NativeOptions): Promise<void> {
  checkNativeRuntime({ version: process.version, platform: process.platform })
  try {
    await verifyNativeSource(options.stage)
    await access(dirname(options.resultPath), constants.W_OK)
    await requireAbsent(options.resultPath)
    await requireAbsent(`${options.resultPath}.launcher.json`)
    if (options.stage === 'capture-diagnostic') {
      await requireAbsent(`${options.resultPath}.diagnostic.json`)
      await requireAbsent(`${options.resultPath}.viewport.png`)
    }
    if (options.stage === 'capture-control')
      await requireAbsent(`${options.resultPath}.captures.json`)
  } catch (error) {
    throw new NativePreconditionError(`Output precondition failed: ${String(error)}`)
  }
}

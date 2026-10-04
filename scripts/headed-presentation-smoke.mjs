import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { observeHyprlandWindow, runHeadedPresentationSmoke } from './comparison-headed.mjs'

const args = process.argv.slice(2)
assert.equal(
  args.length,
  6,
  'Usage: node headed-presentation-smoke.mjs --executable <full-Chrome-binary> --output <new-directory> --window-system hyprland',
)
assert.deepEqual(
  [args[0], args[2], args[4], args[5]],
  ['--executable', '--output', '--window-system', 'hyprland'],
  'Explicit executable, new output directory and optional Hyprland integration required',
)
const output = resolve(args[3])
await mkdir(output)
let evidence
let skipReason
if (process.platform !== 'linux')
  skipReason =
    'Fixed Wayland/Vulkan qualification requires Linux; portable compositor adapters use the library API'
if (!process.env.WAYLAND_DISPLAY || !process.env.XDG_RUNTIME_DIR)
  skipReason = 'No Wayland display available; compositor hardware smoke skipped'
if (!skipReason) {
  try {
    await promisify(execFile)('hyprctl', ['version', '-j'], { timeout: 2000 })
  } catch {
    skipReason =
      'Optional Hyprland observer unavailable; supply another compositor observer through the library API'
  }
}
if (skipReason) {
  evidence = { status: 'SKIP', reason: skipReason, terminalMarkers: 0, measurements: 0 }
} else {
  const taskRoot = resolve(output, 'owned-task')
  await mkdir(taskRoot, { mode: 0o700 })
  try {
    evidence = await runHeadedPresentationSmoke({
      executablePath: resolve(args[1]),
      taskRoot,
      observeWindow: observeHyprlandWindow,
      viewport: { width: 320, height: 440 },
    })
  } catch (error) {
    evidence = {
      status: 'UNKNOWN_FAILED_SETUP',
      error: { name: error.name, message: error.message, code: error.code },
      ...error.launchEvidence,
      terminalMarkers: 0,
      measurements: 0,
    }
    evidence.status = 'UNKNOWN_FAILED_SETUP'
    process.exitCode = 1
  }
}
await writeFile(resolve(output, 'result.json'), JSON.stringify(evidence, null, 2) + '\n')
console.log(
  JSON.stringify({
    status: evidence.status,
    reason: evidence.reason ?? evidence.error?.message,
    output,
  }),
)

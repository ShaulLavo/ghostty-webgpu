import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const displayedFrameBoundariesFile = fileURLToPath(
  new URL('../src/dom/tests/displayed-frame-boundaries.browser.test.ts', import.meta.url),
)

export const displayedFrameBoundariesCases = [
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > preserves previous lazy accepted text when extraction fails after native capture',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:133:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > recovers webgl after acknowledgement fails with populated pending text',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:148:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > recovers webgpu after acknowledgement fails with populated pending text',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:148:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > stages webgl coordinated=false acceptance through acknowledge without prior text demand',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:190:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > stages webgpu coordinated=false acceptance through acknowledge without prior text demand',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:190:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > stages webgpu coordinated=true acceptance through acknowledge without prior text demand',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:190:2',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > stages webgpu coordinated=true acceptance through acceptFrame without prior text demand',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:190:3',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > keeps webgl coordinated=false accepted text through an upload failure without prior text demand',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:235:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > keeps webgpu coordinated=false accepted text through an upload failure without prior text demand',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:235:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > keeps webgpu coordinated=true accepted text through an upload failure without prior text demand',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:235:2',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > reports and recovers captureRetainedFrame failure through coordinated WebGPU commits',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:269:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > reports and recovers readRetainedText failure through coordinated WebGPU commits',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:269:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > bounds coordinated failure retries until another render action',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:300:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > defers pre-open text listeners until public operations are available',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:318:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > keeps public renderer onTextFrame snapshots owned after the next capture',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:335:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > keeps public renderer text snapshots cloneable without public native tokens',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:349:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review text publication reentrancy and device recovery > keeps accessibility on the newest frame after a reentrant WebGPU layout update',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:363:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName: 'keeps Y submitted while X notifies with both coordinated WebGPU images committed',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:412:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]

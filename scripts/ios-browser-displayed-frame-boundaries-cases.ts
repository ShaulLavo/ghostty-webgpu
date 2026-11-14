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
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:135:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > recovers webgl after acknowledgement fails with populated pending text',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:150:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > recovers webgpu after acknowledgement fails with populated pending text',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:150:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > stages webgl coordinated=false acceptance through acknowledge without prior text demand',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:192:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > stages webgpu coordinated=false acceptance through acknowledge without prior text demand',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:192:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > stages webgpu coordinated=true acceptance through acknowledge without prior text demand',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:192:2',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > stages webgpu coordinated=true acceptance through acceptFrame without prior text demand',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:192:3',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > keeps webgl coordinated=false accepted text through an upload failure without prior text demand',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:237:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > keeps webgpu coordinated=false accepted text through an upload failure without prior text demand',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:237:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > keeps webgpu coordinated=true accepted text through an upload failure without prior text demand',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:237:2',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > reports and recovers captureRetainedFrame failure through coordinated WebGPU commits',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:271:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > reports and recovers readRetainedText failure through coordinated WebGPU commits',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:271:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > bounds coordinated failure retries until another render action',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:302:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > defers pre-open text listeners until public operations are available',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:320:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > keeps public renderer onTextFrame snapshots owned after the next capture',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:337:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review failure boundaries > keeps public renderer text snapshots cloneable without public native tokens',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:351:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName:
      'review text publication reentrancy and device recovery > keeps accessibility on the newest frame after a reentrant WebGPU layout update',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:365:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: displayedFrameBoundariesFile,
    fullName: 'keeps Y submitted while X notifies with both coordinated WebGPU images committed',
    sourceKey: 'src/dom/tests/displayed-frame-boundaries.browser.test.ts:414:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]

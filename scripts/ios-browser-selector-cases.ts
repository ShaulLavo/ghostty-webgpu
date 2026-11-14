import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const selectorFile = fileURLToPath(
  new URL('../src/render/tests/selector.browser.test.ts', import.meta.url),
)

export const selectorCases = [
  {
    file: selectorFile,
    fullName: 'compatible renderer selection > selects the real fallback without WebGPU globals',
    sourceKey: 'src/render/tests/selector.browser.test.ts:156:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > selects the automatic renderer for Linux client hints',
    sourceKey: 'src/render/tests/selector.browser.test.ts:162:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > selects the automatic renderer for Linux legacy platform',
    sourceKey: 'src/render/tests/selector.browser.test.ts:162:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName: 'compatible renderer selection > selects the automatic renderer for macOS',
    sourceKey: 'src/render/tests/selector.browser.test.ts:162:2',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName: 'compatible renderer selection > selects the automatic renderer for Windows',
    sourceKey: 'src/render/tests/selector.browser.test.ts:162:3',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > selects the automatic renderer for Android client hints',
    sourceKey: 'src/render/tests/selector.browser.test.ts:162:4',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > selects the automatic renderer for Android legacy platform',
    sourceKey: 'src/render/tests/selector.browser.test.ts:162:5',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > selects the automatic renderer for ChromeOS client hints',
    sourceKey: 'src/render/tests/selector.browser.test.ts:162:6',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > selects the automatic renderer for ChromeOS legacy platform',
    sourceKey: 'src/render/tests/selector.browser.test.ts:162:7',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > selects the automatic renderer for client hints precedence',
    sourceKey: 'src/render/tests/selector.browser.test.ts:162:8',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName: 'compatible renderer selection > selects the automatic renderer for unknown platform',
    sourceKey: 'src/render/tests/selector.browser.test.ts:162:9',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > replaces the claimed Linux canvas after createShader allocation fails and selects WebGPU',
    sourceKey: 'src/render/tests/selector.browser.test.ts:174:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > replaces the claimed Linux canvas after createProgram allocation fails and selects WebGPU',
    sourceKey: 'src/render/tests/selector.browser.test.ts:174:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > replaces the claimed Linux canvas after createBuffer allocation fails and selects WebGPU',
    sourceKey: 'src/render/tests/selector.browser.test.ts:174:2',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > replaces the claimed Linux canvas after createVertexArray allocation fails and selects WebGPU',
    sourceKey: 'src/render/tests/selector.browser.test.ts:174:3',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > replaces the claimed Linux canvas after createTexture allocation fails and selects WebGPU',
    sourceKey: 'src/render/tests/selector.browser.test.ts:174:4',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > continues to WebGPU after a Linux WebGL limits capability failure',
    sourceKey: 'src/render/tests/selector.browser.test.ts:204:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > continues to WebGPU after a Linux WebGL out-of-memory capability failure',
    sourceKey: 'src/render/tests/selector.browser.test.ts:204:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > keeps Linux shader programming failures visible without replacing the canvas',
    sourceKey: 'src/render/tests/selector.browser.test.ts:226:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > selects canvas2d after Linux WebGL allocation and WebGPU capability failures',
    sourceKey: 'src/render/tests/selector.browser.test.ts:241:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > selects dom after Linux WebGL allocation and WebGPU capability failures',
    sourceKey: 'src/render/tests/selector.browser.test.ts:241:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > replaces an unmanaged HTML canvas after Linux resource allocation fails',
    sourceKey: 'src/render/tests/selector.browser.test.ts:264:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > tries hardware WebGPU after the initial Linux WebGL context is lost',
    sourceKey: 'src/render/tests/selector.browser.test.ts:276:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > skips previously unavailable WebGPU after a WebGL-first fallback on macOS loses its context',
    sourceKey: 'src/render/tests/selector.browser.test.ts:301:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > disposes WebGPU recovery that finishes after abort and preserves settings while acquiring it',
    sourceKey: 'src/render/tests/selector.browser.test.ts:324:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > disposes WebGPU recovery that finishes after dispose and preserves settings while acquiring it',
    sourceKey: 'src/render/tests/selector.browser.test.ts:324:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > uses the managed WebGL fallback first on desktop Linux',
    sourceKey: 'src/render/tests/selector.browser.test.ts:368:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > selects WebGPU on desktop Linux when WebGL is unavailable',
    sourceKey: 'src/render/tests/selector.browser.test.ts:382:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > selects canvas2d on desktop Linux after both GPU capabilities are unavailable',
    sourceKey: 'src/render/tests/selector.browser.test.ts:395:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > selects dom on desktop Linux after both GPU capabilities are unavailable',
    sourceKey: 'src/render/tests/selector.browser.test.ts:395:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > stops Linux fallback when aborted during the first WebGL attempt',
    sourceKey: 'src/render/tests/selector.browser.test.ts:423:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > selects WebGL for a software adapter in auto ({"isFallbackAdapter":true,"info":{}})',
    sourceKey: 'src/render/tests/selector.browser.test.ts:442:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > selects WebGL for a software adapter in auto ({"isFallbackAdapter":false,"info":{"isFallbackAdapter":true}})',
    sourceKey: 'src/render/tests/selector.browser.test.ts:442:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > selects WebGL for a software adapter in auto ({"isFallbackAdapter":false,"info":{"description":"Google SwiftShader"}})',
    sourceKey: 'src/render/tests/selector.browser.test.ts:442:2',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > selects WebGL for a software adapter in auto ({"isFallbackAdapter":false,"info":{"architecture":"llvmpipe"}})',
    sourceKey: 'src/render/tests/selector.browser.test.ts:442:3',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > allows a software adapter with explicit WebGPU while auto selects WebGL',
    sourceKey: 'src/render/tests/selector.browser.test.ts:465:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName: 'compatible renderer selection > keeps a hardware adapter eligible for auto',
    sourceKey: 'src/render/tests/selector.browser.test.ts:484:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > selects real WebGPU without acquiring a fallback context',
    sourceKey: 'src/render/tests/selector.browser.test.ts:499:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > selects real WebGL2 when no WebGPU adapter is available',
    sourceKey: 'src/render/tests/selector.browser.test.ts:509:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > releases the real WebGPU device before selecting WebGL2 after a missing context',
    sourceKey: 'src/render/tests/selector.browser.test.ts:519:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > selects real Canvas2D after both GPU capabilities are unavailable',
    sourceKey: 'src/render/tests/selector.browser.test.ts:535:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > propagates WebGPU programming failures without trying another context',
    sourceKey: 'src/render/tests/selector.browser.test.ts:557:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > propagates invalid input before acquiring any device or context',
    sourceKey: 'src/render/tests/selector.browser.test.ts:571:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > propagates WebGL shader failures without claiming a Canvas2D context',
    sourceKey: 'src/render/tests/selector.browser.test.ts:581:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName: 'compatible renderer selection > does not start a renderer when already aborted',
    sourceKey: 'src/render/tests/selector.browser.test.ts:592:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > stops fallback when aborted while WebGPU initialization fails',
    sourceKey: 'src/render/tests/selector.browser.test.ts:606:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > disposes a WebGPU renderer that finishes after cancellation',
    sourceKey: 'src/render/tests/selector.browser.test.ts:626:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > disposes a webgl2 renderer that finishes after cancellation',
    sourceKey: 'src/render/tests/selector.browser.test.ts:649:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > disposes a canvas2d renderer that finishes after cancellation',
    sourceKey: 'src/render/tests/selector.browser.test.ts:649:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: selectorFile,
    fullName:
      'compatible renderer selection > stops fallback when aborted while WebGL2 is found unavailable',
    sourceKey: 'src/render/tests/selector.browser.test.ts:673:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]

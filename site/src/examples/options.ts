import type { GhosttyWebGpuTerminalOptions } from 'ghostty-webgpu'
import type { WorkerTerminalOptions } from 'ghostty-webgpu/worker'

export const mainOptions = [
  'appearance',
  'rendererMode',
  'rendererFactory',
  'keyboard',
  'accessibility',
  'clipboardWrite',
  'extensions',
  'links',
  'padding',
  'scrollbar',
  'runtime',
] as const satisfies readonly (keyof GhosttyWebGpuTerminalOptions)[]

export const workerOptions = [
  'fonts',
  'backend',
  'assets',
  'workerUrl',
  'appearance',
] as const satisfies readonly (keyof WorkerTerminalOptions)[]

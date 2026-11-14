import { TestRunner } from 'vitest'

export function requireWebGpu(
  context: { skip(note: string): void } | undefined = TestRunner.getCurrentTest()?.context,
): void {
  if (navigator.gpu) return
  if (!context) throw new Error('WebGPU capability checks require a test context')
  context.skip('This browser does not expose the WebGPU API')
}

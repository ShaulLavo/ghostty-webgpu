import { TestRunner } from 'vitest'
import { workerWebglSkipReason } from '../../bidi/tests/browser-capabilities.js'

let qualification: Promise<string | undefined> | undefined

export async function requireWorkerWebGl(): Promise<void> {
  const context = TestRunner.getCurrentTest()?.context
  qualification ??= workerWebglSkipReason()
  const reason = await qualification
  if (!reason) return
  if (!context) throw new Error('Worker capability checks require a test context')
  context.skip(reason)
}

import { afterEach, aroundEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requireWebGpu } from '../../../src/render/tests/webgpu-capability.ts'
import { requireWorkerWebGl } from '../../../src/render/tests/worker-webgl-capability.ts'

async function cleaned(name: string, phase: string): Promise<void> {
  const response = await fetch('/ghostty-local-cleanup', {
    method: 'POST',
    body: JSON.stringify({ name, phase }),
  })
  if (!response.ok) throw new Error(await response.text())
}

afterEach(async ({ task }) => {
  vi.unstubAllGlobals()
  await cleaned(task.id, 'afterEach')
})
aroundEach(async (run, { task }) => {
  try {
    await run()
  } finally {
    await cleaned(task.id, 'aroundEach')
  }
})

it('missing sync', () => {
  vi.stubGlobal('navigator', {})
  requireWebGpu()
  throw new Error('A skipped body continued')
})

it('missing async', async () => {
  await Promise.resolve()
  vi.stubGlobal('navigator', {})
  requireWebGpu()
  throw new Error('A skipped async body continued')
})

it('worker capability', async () => {
  await requireWorkerWebGl()
  expect(true).toBe(true)
})

it('supported acquisition fails', async () => {
  vi.stubGlobal('navigator', {
    gpu: {
      requestAdapter: async () => {
        throw new Error('CONTROL_ACQUISITION_FAILURE')
      },
    },
  })
  requireWebGpu()
  await navigator.gpu.requestAdapter()
})

it('sibling still runs', () => {
  expect(true).toBe(true)
})

describe('GPU hook', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', {})
    requireWebGpu()
  })
  it('missing beforeEach', () => {
    throw new Error('A skipped hook body continued')
  })
})

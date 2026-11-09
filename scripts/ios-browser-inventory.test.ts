import { afterEach, expect, test, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createVitest } from 'vitest/node'
import { fileURLToPath } from 'node:url'
import { collectDesktopInventory } from './fixtures/ios-browser/desktop-inventory.ts'
import * as bridge from './ios-browser-page.ts'

async function installedCollection(
  rpc: () => Promise<void>,
  observation: { collected(): Promise<void> },
): Promise<void> {
  const root = dirname(fileURLToPath(import.meta.resolve('@vitest/browser/package.json')))
  const source = await readFile(
    join(root, 'dist/client/__vitest_browser__/tester-COH68OX9.js'),
    'utf8',
  )
  const start = source.indexOf('_defineProperty(this, "onCollected", ')
  const end = source.indexOf('_defineProperty(this, "onTestAnnotate", ', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const declaration = source.slice(start, end).trim()
  const create = new Function(
    'rpc$2',
    'ghostty',
    'state',
    `let hook; const _defineProperty = (_owner, _name, value) => { hook = value; }; ${declaration} return hook;`,
  )
  const hook: unknown = create.call(
    { config: { includeTaskLocation: false }, method: 'run' },
    () => ({ onCollected: rpc }),
    observation,
    { durations: { prepare: 0, environment: 0 } },
  )
  if (typeof hook !== 'function') throw new Error('Installed collection hook not found')
  await hook([])
}

afterEach(() => vi.unstubAllGlobals())

test('inventory refusal stops the installed collection owner before hooks independently of reporting', async () => {
  const events: { event: string; role: string }[] = []
  const normal: string[] = []
  const observed = vi.fn(async () => {})
  const execution = async () => {
    await installedCollection(
      async () => {
        collectDesktopInventory({ mode: 'inventory-reject', normal, events })
      },
      { collected: observed },
    )
    events.push({ event: 'before-all', role: 'body' })
  }
  await expect(execution()).rejects.toThrow('LOCAL_INVENTORY_REJECT')
  expect(normal).toEqual(['ordinary-collected'])
  expect(events).toEqual([{ event: 'collected', role: 'node' }])
  expect(observed).not.toHaveBeenCalled()
})

test('ordinary collection still runs after a reporting rejection without an inventory veto', async () => {
  const normal: string[] = []
  const events: { event: string; role: string }[] = []
  const observed = vi.fn(() => Promise.reject(new Error('LOCAL_REPORTING_ONLY')))
  vi.stubGlobal('document', {})
  vi.stubGlobal(Symbol.for('waffle.framework.observation'), () => ({
    signal: new AbortController().signal,
    collected: observed,
  }))
  const context = await createVitest(
    'test',
    { config: false, watch: false },
    {
      test: { include: [], browser: { enabled: false } },
    },
  )
  try {
    const config = context.getRootProject().serializedConfig
    await installedCollection(
      async () => {
        collectDesktopInventory({ mode: 'clean', normal, events })
      },
      {
        collected: async () => {
          await bridge.collected([], config)
        },
      },
    )
  } finally {
    await context.close()
  }
  events.push({ event: 'before-all', role: 'body' })
  expect(normal).toEqual(['ordinary-collected'])
  expect(events).toEqual([{ event: 'before-all', role: 'body' }])
  expect(observed).toHaveBeenCalledTimes(1)
})

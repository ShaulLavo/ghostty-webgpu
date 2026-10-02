import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analysisArguments, positiveInteger } from './comparison-options.mjs'

test('sample overrides require finite positive integers and a value', () => {
  for (const value of [undefined, '--output', 'NaN', 'Infinity', '1.5', '0', '-1']) {
    const args = value === undefined ? ['--samples'] : ['--samples', value]
    assert.throws(() => positiveInteger(args, '--samples', 48))
  }
  assert.equal(positiveInteger([], '--samples', 48), 48)
  assert.equal(positiveInteger(['--samples', '24'], '--samples', 48), 24)
})

test('compact analysis flag is never interpreted as an output filename', () => {
  assert.deepEqual(analysisArguments(['directory', '--compact']), {
    input: 'directory',
    output: undefined,
    compact: true,
  })
  assert.deepEqual(analysisArguments(['--compact', 'directory', 'output.json']), {
    input: 'directory',
    output: 'output.json',
    compact: true,
  })
  assert.throws(() => analysisArguments(['directory', '--unknown']))
})

test('Linux hardware runs are headless Vulkan and Mac measurements stay headed', async () => {
  const { hardwareLaunch } = await import('./comparison-options.mjs')
  assert.deepEqual(hardwareLaunch('linux', false), {
    headless: true,
    arguments: ['--enable-features=Vulkan', '--use-angle=vulkan', '--ignore-gpu-blocklist'],
  })
  assert.equal(hardwareLaunch('darwin', false).headless, false)
  assert.deepEqual(hardwareLaunch('linux', true).arguments, [])
})

test('measurement selections reject missing, unsupported and duplicate values', async () => {
  const { selection } = await import('./comparison-options.mjs')
  assert.deepEqual(selection(['--counts', '1,17'], '--counts', ['1'], ['1', '8', '17']), [
    '1',
    '17',
  ])
  for (const value of [undefined, '--output', '2', '1,1', ''])
    assert.throws(() => selection(['--counts', value], '--counts', ['1'], ['1', '8', '17']))
})

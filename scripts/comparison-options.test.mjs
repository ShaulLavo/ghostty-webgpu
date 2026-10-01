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

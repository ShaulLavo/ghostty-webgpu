import assert from 'node:assert/strict'

export function positiveInteger(args, flag, fallback) {
  const index = args.indexOf(flag)
  const value = index < 0 ? fallback : args[index + 1]
  assert(value !== undefined && !String(value).startsWith('--'), `${flag} needs a value`)
  const number = Number(value)
  assert(Number.isSafeInteger(number) && number > 0, `${flag} must be a positive integer`)
  return number
}

export function analysisArguments(args) {
  const positional = args.filter((arg) => !arg.startsWith('--'))
  assert(
    args.every((arg) => !arg.startsWith('--') || arg === '--compact'),
    'Unknown analysis flag',
  )
  assert(
    positional.length >= 1 && positional.length <= 2,
    'Input directory and optional output required',
  )
  return { input: positional[0], output: positional[1], compact: args.includes('--compact') }
}

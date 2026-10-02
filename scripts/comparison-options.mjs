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

export function selection(args, flag, fallback, allowed) {
  const index = args.indexOf(flag)
  if (index < 0) return fallback
  const value = args[index + 1]
  assert(value && !value.startsWith('--'), `${flag} needs a comma-separated value`)
  const selected = value.split(',')
  assert(selected.length === new Set(selected).size, `${flag} contains duplicates`)
  assert(
    selected.every((item) => allowed.includes(item)),
    `${flag} contains an unsupported value`,
  )
  return selected
}

export function hardwareLaunch(host, smoke, smokeHeaded = false) {
  const headless = host === 'linux' ? !smokeHeaded : smoke && !smokeHeaded
  const arguments_ =
    host === 'linux' && !smoke
      ? ['--enable-features=Vulkan', '--use-angle=vulkan', '--ignore-gpu-blocklist']
      : []
  return { headless, arguments: arguments_ }
}

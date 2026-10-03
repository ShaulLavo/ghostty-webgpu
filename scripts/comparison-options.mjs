import assert from 'node:assert/strict'

export function positiveInteger(args, flag, fallback) {
  const index = args.indexOf(flag)
  const value = index < 0 ? fallback : args[index + 1]
  assert(value !== undefined && !String(value).startsWith('--'), `${flag} needs a value`)
  const number = Number(value)
  assert(Number.isSafeInteger(number) && number > 0, `${flag} must be a positive integer`)
  return number
}

export function gpuCommandTimeout(settings, tracing) {
  const key = tracing ? 'gpuTraceCommandTimeoutMilliseconds' : 'gpuCommandTimeoutMilliseconds'
  const timeout = settings[key]
  assert(Number.isSafeInteger(timeout) && timeout > 0, `Positive ${key} required`)
  return timeout
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

export const counterparts = {
  'ghostty-webgpu': 'xterm-webgl',
  'ghostty-webgl': 'xterm-webgl',
  'ghostty-canvas': 'ghostty-web',
  'ghostty-dom': 'xterm-dom',
}

export const measurementPhases = ['parser', 'memory', 'idle', 'latency', 'burst', 'output']

export function frameBuilders(args) {
  assert(
    !(args.includes('--paired-frame-builders') && args.includes('--frame-builders')),
    'Choose --frame-builders or --paired-frame-builders',
  )
  return selection(
    args,
    '--frame-builders',
    args.includes('--paired-frame-builders') ? ['js', 'zig'] : ['js'],
    ['js', 'zig'],
  )
}

export function selectedVariants(args, available, fallback) {
  const selected = [...selection(args, '--variants', fallback, available)]
  for (const native of selected) {
    const counterpart = counterparts[native]
    if (counterpart && !selected.includes(counterpart)) selected.push(counterpart)
  }
  return selected
}

export function outputFixture(args, fixtures) {
  const names = fixtures.map(({ name }) => name)
  const selected = selection(args, '--output-fixture', ['ascii'], names)
  assert(selected.length === 1 && names.includes(selected[0]), '--output-fixture needs one fixture')
  return selected[0]
}

export function selectedTracePhases(args, fixtures) {
  return selection(
    args,
    '--trace-phase',
    ['latency', 'ascii', 'sgr'],
    ['latency', ...fixtures.map(({ name }) => name)],
  )
}

export function selectedPhases(args) {
  return selection(args, '--phases', measurementPhases, measurementPhases)
}

export function measurementCases(variants, paths, counts, builders, repetition) {
  const ordered = (values) => {
    const offset = Math.floor(repetition / 2) % values.length
    const rotated = [...values.slice(offset), ...values.slice(0, offset)]
    return repetition % 2 ? rotated.reverse() : rotated
  }
  const treatments = ordered(variants).flatMap((variant) => {
    if (variant !== 'ghostty-webgpu') return [{ variant }]
    return ordered(builders).map((frameBuilder) => ({ variant, frameBuilder }))
  })
  return (repetition % 2 ? paths.toReversed() : paths).flatMap((path) =>
    counts.flatMap((count) => treatments.map((treatment) => ({ ...treatment, path, count }))),
  )
}

export function measurementRepetitions(args, fallback) {
  const repetitions = positiveInteger(args, '--repetitions', fallback)
  assert(
    repetitions >= 4 && repetitions % 2 === 0,
    'Measurements require an even number of at least four repetitions',
  )
  return repetitions
}

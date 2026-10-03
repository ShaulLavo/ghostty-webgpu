function metricDelta(before: object | undefined, after: object | undefined) {
  if (!before || !after) return undefined
  const delta: Record<string, number> = {}
  for (const [key, value] of Object.entries(after)) {
    const previous: unknown = Reflect.get(before, key)
    if (typeof value !== 'number' || typeof previous !== 'number') continue
    delta[key] = value - previous
  }
  return delta
}

export function frameMetricDeltas(
  before: readonly (object | undefined)[],
  after: readonly (object | undefined)[],
) {
  return after.map((snapshot, terminal) => ({
    terminal,
    before: before[terminal],
    after: snapshot,
    delta: metricDelta(before[terminal], snapshot),
  }))
}

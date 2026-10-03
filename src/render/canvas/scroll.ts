export interface CanvasScrollPlan {
  readonly offset: number
  readonly reused: ReadonlySet<number>
}

function matchingRows(
  previous: ReadonlyMap<number, string>,
  next: ReadonlyMap<number, string>,
  offset: number,
): Set<number> {
  const reused = new Set<number>()
  for (const [y, key] of next) {
    if (previous.get(y - offset) === key) reused.add(y)
  }
  return reused
}

/** Keys encode complete cell content, including style and selection, without hashing. */
export function canvasScrollPlan(
  previous: ReadonlyMap<number, string>,
  next: ReadonlyMap<number, string>,
  rowCount: number,
): CanvasScrollPlan {
  const stationary = matchingRows(previous, next, 0)
  if (previous.size !== rowCount || next.size !== rowCount) {
    return { offset: 0, reused: stationary }
  }
  const unique = new Map<string, number | undefined>()
  for (const [y, key] of previous) {
    unique.set(key, unique.has(key) ? undefined : y)
  }
  const offsets = new Map<number, number>()
  for (const [y, key] of next) {
    const source = unique.get(key)
    if (source === undefined) continue
    const offset = y - source
    if (offset === 0) continue
    offsets.set(offset, (offsets.get(offset) ?? 0) + 1)
  }
  let offset = 0
  let anchors = 0
  for (const [candidate, count] of offsets) {
    if (count <= anchors) continue
    offset = candidate
    anchors = count
  }
  if (anchors === 0) return { offset: 0, reused: stationary }
  const reused = matchingRows(previous, next, offset)
  if (reused.size <= stationary.size || reused.size < 2) {
    return { offset: 0, reused: stationary }
  }
  return { offset, reused }
}

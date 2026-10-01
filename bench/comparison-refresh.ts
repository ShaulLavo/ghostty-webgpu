interface Probe {
  samples: number[]
  previous: number | undefined
  frame: number | undefined
  resolve: (samples: number[]) => void
}

export function refreshSampler(
  requestFrame: (tick: (time: number) => void) => number,
  cancelFrame: (id: number) => void,
) {
  let active: Probe | undefined
  const cancel = () => {
    const probe = active
    if (!probe) return []
    active = undefined
    if (probe.frame !== undefined) cancelFrame(probe.frame)
    probe.resolve(probe.samples)
    return probe.samples
  }
  return {
    cancel,
    start(count: number): Promise<number[]> {
      cancel()
      return new Promise((resolve) => {
        const probe: Probe = { samples: [], previous: undefined, frame: undefined, resolve }
        active = probe
        const tick = (time: number) => {
          // A cancelled callback may already be queued; it must never reach the next probe.
          if (active !== probe) return
          if (probe.previous !== undefined) probe.samples.push(time - probe.previous)
          probe.previous = time
          if (probe.samples.length === count) {
            active = undefined
            resolve(probe.samples)
            return
          }
          probe.frame = requestFrame(tick)
        }
        probe.frame = requestFrame(tick)
      })
    },
  }
}

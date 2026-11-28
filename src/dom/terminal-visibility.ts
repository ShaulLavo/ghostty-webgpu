export function observeTerminalVisibility(
  root: HTMLElement,
  onVisible: (visible: boolean) => void,
): () => void {
  let stopped = false
  const intersection = new IntersectionObserver(
    (entries) => {
      const entry = entries.at(-1)
      if (stopped || !entry) return
      onVisible(
        entry.boundingClientRect.width > 0 &&
          entry.boundingClientRect.height > 0 &&
          entry.intersectionRect.width > 0 &&
          entry.intersectionRect.height > 0,
      )
    },
    { threshold: [0, Number.EPSILON] },
  )
  const resize = new ResizeObserver(() => {
    if (stopped) return
    // Zero-size targets can keep the same intersection ratio, so request a fresh entry.
    intersection.unobserve(root)
    intersection.observe(root)
  })
  const stop = () => {
    stopped = true
    resize.disconnect()
    intersection.disconnect()
  }
  try {
    intersection.observe(root)
    resize.observe(root, { box: 'border-box' })
  } catch (cause) {
    stop()
    throw cause
  }
  return stop
}

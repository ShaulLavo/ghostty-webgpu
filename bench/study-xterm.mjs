export function pinXtermStudyGeometry(addon, columns, rows) {
  const renderer = Reflect.get(addon, '_renderer')
  const observer = Reflect.get(renderer, '_observerDisposable')
  if (typeof observer?.clear !== 'function' || typeof renderer?.handleResize !== 'function')
    throw new Error('Pinned xterm WebGL renderer observer/resize contract required')
  observer.clear()
  renderer.handleResize(columns, rows)
}

import type { TerminalElements } from '../dom/elements.js'
import type { WorkerLayout } from './protocol.js'

/** Only DOM dimensions cross this seam. The execution actor owns font measurement. */
export function workerLayout(
  elements: TerminalElements,
  identity: number,
  scrollbarWidth: number,
  autoFit: boolean,
): WorkerLayout {
  const root = elements.root
  const view = root.ownerDocument.defaultView!
  return {
    identity,
    width: root.clientWidth,
    height: root.clientHeight,
    pixelRatio: view.devicePixelRatio,
    padding: elements.padding,
    scrollbarWidth,
    autoFit,
  }
}

export function observeWorkerLayout(elements: TerminalElements, onLayout: () => void): () => void {
  const view = elements.root.ownerDocument.defaultView!
  const observer = new ResizeObserver(onLayout)
  observer.observe(elements.root)
  view.addEventListener('resize', onLayout, { signal: elements.signal })
  let media = view.matchMedia(`(resolution: ${view.devicePixelRatio}dppx)`)
  const change = () => {
    media.removeEventListener('change', change)
    media = view.matchMedia(`(resolution: ${view.devicePixelRatio}dppx)`)
    media.addEventListener('change', change)
    onLayout()
  }
  media.addEventListener('change', change)
  return () => {
    observer.disconnect()
    media.removeEventListener('change', change)
  }
}

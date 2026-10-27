import type { TerminalElements } from '../dom/elements.js'
import { terminalPixelRatio, type TerminalFitEnvironment } from '../dom/fit.js'
import type { WorkerLayout } from './protocol.js'

/** Only DOM dimensions cross this seam. The execution actor owns font measurement. */
export function workerLayout(
  elements: TerminalElements,
  identity: number,
  scrollbarWidth: number,
  autoFit: boolean,
  environment?: Partial<TerminalFitEnvironment>,
): WorkerLayout {
  const root = elements.root
  return {
    identity,
    width: root.clientWidth,
    height: root.clientHeight,
    pixelRatio: terminalPixelRatio(root, environment),
    padding: elements.padding,
    scrollbarWidth,
    autoFit,
  }
}

export function observeWorkerLayout(
  elements: TerminalElements,
  onLayout: () => void,
  environment?: Partial<TerminalFitEnvironment>,
): () => void {
  const view = elements.root.ownerDocument.defaultView!
  const observer = new ResizeObserver(onLayout)
  observer.observe(elements.root)
  const subscribe = environment?.subscribePixelRatio
  if (subscribe) {
    let dispose: unknown
    try {
      dispose = subscribe.call(environment, onLayout)
    } catch (cause) {
      observer.disconnect()
      throw cause
    }
    if (typeof dispose !== 'function') {
      observer.disconnect()
      throw new TypeError('subscribePixelRatio must return a dispose function')
    }
    return () => {
      observer.disconnect()
      dispose()
    }
  }
  view.addEventListener('resize', onLayout, { signal: elements.signal })
  let media = view.matchMedia(`(resolution: ${terminalPixelRatio(elements.root, environment)}dppx)`)
  const change = () => {
    media.removeEventListener('change', change)
    media = view.matchMedia(`(resolution: ${terminalPixelRatio(elements.root, environment)}dppx)`)
    media.addEventListener('change', change)
    onLayout()
  }
  media.addEventListener('change', change)
  return () => {
    observer.disconnect()
    media.removeEventListener('change', change)
  }
}

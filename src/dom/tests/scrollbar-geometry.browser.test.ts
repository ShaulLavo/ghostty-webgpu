import { expect, it } from 'vitest'
import { createTerminalScrollbar } from '../scrollbar.js'

it('aligns fractional thumb heights with the track ends through parent resizes', () => {
  const root = document.createElement('div')
  root.style.cssText = 'position:relative;width:48px;height:264px'
  document.body.append(root)
  const scrollbar = createTerminalScrollbar({
    root,
    snapshot: { length: 8, offset: 92, total: 100 },
    actions: { scrollBy() {}, scrollToBottom() {}, scrollToRow() {}, scrollToTop() {} },
  })
  try {
    scrollbar.notifyActivity()
    for (const height of [264, 265, 300, 123.5]) {
      root.style.height = `${height}px`
      scrollbar.update({ length: 8, offset: 92, total: 100 })
      const track = scrollbar.element.getBoundingClientRect()
      expect(scrollbar.thumb.getBoundingClientRect().bottom).toBeCloseTo(track.bottom, 1)
      scrollbar.update({ length: 8, offset: 0, total: 100 })
      expect(scrollbar.thumb.getBoundingClientRect().top).toBeCloseTo(track.top, 1)
    }
  } finally {
    scrollbar.dispose()
    root.remove()
  }
})

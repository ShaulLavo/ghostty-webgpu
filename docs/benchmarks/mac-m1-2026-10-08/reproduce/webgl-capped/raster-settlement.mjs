import assert from 'node:assert/strict'

export async function settleScreenshot(page) {
  // xterm scrollbars have 100/800 ms opacity transitions. Keep their final visibility policy unchanged.
  await page.waitForTimeout(1600)
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('.xterm-scrollable-element > .scrollbar')).every(
        (element) => ['0', '1'].includes(getComputedStyle(element).opacity),
      ),
    null,
    { timeout: 4000 },
  )
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )
  const controls = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.xterm-scrollable-element > .scrollbar')).map(
      (element) => {
        const rect = element.getBoundingClientRect()
        return {
          className: element.className,
          opacity: getComputedStyle(element).opacity,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        }
      },
    ),
  )
  assert(
    controls.every((control) => ['0', '1'].includes(control.opacity)),
    'Transient scrollbar opacity remains at screenshot boundary',
  )
  return {
    controls,
    scope:
      'Read-only observation after native endpoint; unchanged terminal workload, no pixel masking, cursor hiding or screenshot normalization',
  }
}

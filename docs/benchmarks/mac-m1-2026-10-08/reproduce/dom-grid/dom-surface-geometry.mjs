export function readDomSurfaceGeometry() {
  const main = document.querySelector('main')
  const scale = main.getBoundingClientRect().width / main.offsetWidth
  const describe = (element) => {
    if (!element) return null
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return {
      className: element.className,
      rect: rect.toJSON(),
      layoutWidth: rect.width / scale,
      layoutHeight: rect.height / scale,
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      display: style.display,
      opacity: style.opacity,
      visibility: style.visibility,
      overflow: style.overflow,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      visible: element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
    }
  }
  return {
    dpr: devicePixelRatio,
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
    scale,
    targets: Array.from(main.querySelectorAll('section'), (section, index) => {
      const grid = section.querySelector('.ghostty-webgpu-frame, .xterm-rows')
      return {
        index,
        host: describe(section),
        grid: describe(grid),
        row: describe(grid?.firstElementChild),
        scrollbars: Array.from(
          section.querySelectorAll(
            '.ghostty-webgpu-scrollbar, .xterm-scrollable-element > .scrollbar',
          ),
          describe,
        ),
      }
    }),
  }
}

export function applyDomSurfaceNormalization({ panelHeight, hideScrollbars }) {
  document.querySelectorAll('main > section').forEach((section) => {
    section.style.height = `${panelHeight}px`
  })
  if (hideScrollbars) {
    const style = document.createElement('style')
    style.dataset.twDomNormalization = 'scrollbar-raster-off'
    style.textContent =
      '.ghostty-webgpu-scrollbar, .xterm-scrollable-element > .scrollbar { display: none !important; }'
    document.head.append(style)
  }
}

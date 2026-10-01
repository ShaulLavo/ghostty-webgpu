// The ghost is ASCII with a hidden cursor; its shared cell runs can flow as one preformatted grid.
export function compactGhostHtml(html: string): string {
  const frameStyle = /class="ghostty-webgpu-frame"[^>]*style="([^"]*)"/.exec(html)![1]!
  const styles = new Map<string, string>()
  const rows = Array.from(
    html.matchAll(/<div data-row="(\d+)" style="[^"]*">(.*?)<\/div>/g),
    ([, y, row]) => {
      const runs = row!.replace(/ style="([^"]*)"/g, (_, style: string) => {
        const paint = style
          .split(';')
          .filter(
            (declaration) =>
              /^(color|background-color|font-weight|font-style|text-decoration[^:]*):/.test(
                declaration,
              ) &&
              declaration !== 'font-weight:400' &&
              declaration !== 'font-style:normal',
          )
          .join(';')
        let name = styles.get(paint)
        if (!name) {
          name = `g${styles.size}`
          styles.set(paint, name)
        }
        return ` class="${name}"`
      })
      return `<span data-row="${y}">${runs}</span>`
    },
  )
  const paint = Array.from(styles, ([style, name]) => `#ghost-first-frame .${name}{${style}}`).join(
    '',
  )
  return `<style>${paint}</style><pre class="ghostty-webgpu-frame" aria-hidden="true" style="${frameStyle};margin:0;letter-spacing:calc(var(--ghostty-cell-width, 6px) - 1ch)">${rows.join('\n')}</pre>`
}

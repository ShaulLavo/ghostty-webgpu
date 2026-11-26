const base = import.meta.env.BASE_URL.replace(/\/$/, '')

export const docsHref = (slug = '') => `${base}/docs/${slug ? `${slug}/` : ''}`

interface DocLink {
  readonly label: string
  readonly href: string
  readonly code?: boolean
}

export const docsIndex: readonly { readonly title: string; readonly links: readonly DocLink[] }[] =
  [
    {
      title: 'Start here',
      links: [
        { label: 'Quick start', href: docsHref('start/quick-start') },
        { label: 'A real shell in the browser', href: docsHref('start/real-shell') },
        { label: 'Coming from xterm.js', href: docsHref('start/xterm') },
        { label: 'Coming from ghostty-web', href: docsHref('start/ghostty-web') },
      ],
    },
    {
      title: 'Guides',
      links: [
        { label: 'Connect to a PTY', href: docsHref('guides/pty') },
        { label: 'Renderers and fallbacks', href: docsHref('guides/renderers') },
        { label: 'Run in a worker', href: docsHref('guides/workers') },
        { label: 'Fonts', href: docsHref('guides/fonts') },
      ],
    },
    {
      title: 'Reference',
      links: [
        { label: 'ghostty-webgpu', href: docsHref('reference/api'), code: true },
        { label: '/worker', href: docsHref('reference/worker-api'), code: true },
        { label: 'Options', href: docsHref('reference/options') },
        { label: 'Config resolver', href: docsHref('reference/config-api') },
      ],
    },
    {
      title: 'Concepts',
      links: [
        { label: 'How it works', href: docsHref('concepts/how-it-works') },
        { label: 'Damage tracking', href: docsHref('concepts/damage-tracking') },
        { label: 'Benchmarks', href: docsHref('concepts/benchmarks') },
        {
          label: 'Correctness',
          href: 'https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/correctness.md',
        },
      ],
    },
  ]

const repo = (path: string) => `https://github.com/ShaulLavo/ghostty-webgpu/blob/main/${path}`

export const roadmap: readonly {
  readonly state: 'done' | 'progress'
  readonly text: string
  readonly plan: string
}[] = [
  {
    state: 'done',
    text: 'Canvas-first startup: paint the first frame on Canvas 2D while WebGPU or WebGL2 warms up, then swap in place.',
    plan: repo('docs/concepts.md'),
  },
  {
    state: 'done',
    text: 'Worker execution and TerminalWorkerPool: run libghostty-vt, Zig frame building, and GPU rendering on OffscreenCanvas.',
    plan: repo('docs/concepts.md'),
  },
  {
    state: 'done',
    text: 'DEC mode 2026 synchronized output, opt-in GSUB ligatures, lazy BiDi, and public extensions including @ghostty-webgpu/line-editor.',
    plan: repo('docs/api.md'),
  },
  {
    state: 'progress',
    text: 'Single-pass colour-glyph detection to cut glyph-churn rasterization cost on CJK and emoji bursts.',
    plan: repo('docs/benchmarks.md'),
  },
  {
    state: 'progress',
    text: 'Retained-buffer search, Sixel and Kitty image protocols, and a full screen-reader audit.',
    plan: repo('docs/status.md'),
  },
]

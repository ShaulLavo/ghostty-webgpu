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

const plan = (file: string) => `https://github.com/ShaulLavo/fregat/blob/main/plans/${file}.md`

export const roadmap: readonly {
  readonly state: 'done' | 'progress'
  readonly text: string
  readonly plan: string
}[] = [
  {
    state: 'progress',
    text: 'WebGL line scroll and Unicode cost, the two WebGL losses above.',
    plan: plan('283-ghostty-output-and-input-latency'),
  },
  {
    state: 'progress',
    text: 'DOM typing-like edit cost.',
    plan: plan('283-ghostty-output-and-input-latency'),
  },
  {
    state: 'progress',
    text: 'Worker mode: the whole terminal on an OffscreenCanvas, with every renderer.',
    plan: plan('287-ghostty-worker-mode'),
  },
  {
    state: 'progress',
    text: 'Extensions: the addons xterm.js users expect, on a public API, starting with a line editor.',
    plan: plan('286-ghostty-extensions'),
  },
  {
    state: 'done',
    text: "First frame rendered into the page's HTML, with the live renderer taking over in place.",
    plan: plan('285-ghostty-site-first-frame-and-real-shell'),
  },
]

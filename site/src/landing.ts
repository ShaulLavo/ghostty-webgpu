import type { PieceName } from 'ascii.rest'
import type { Art } from './scene/art'
import type { Scene } from './scene/scenes'

interface PageData {
  readonly facts: readonly (readonly [string, string])[]
  readonly charts: readonly ({
    readonly data: Record<string, number>
    readonly max: number
  } | null)[]
  readonly scores: readonly {
    readonly label: string
    readonly value: number
    readonly ours: boolean
  }[]
}

const TAB_STEPS: Readonly<Record<string, number>> = { ArrowLeft: -1, ArrowRight: 1 }

function json<T>(id: string): T {
  return JSON.parse(document.getElementById(id)!.textContent!) as T
}

const scenes = json<Scene[]>('scenes')
const page = json<PageData>('page-data')
const scene =
  scenes.find((entry) => entry.name === document.documentElement.dataset['scene']) ?? scenes[0]!
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

/** Draws each piece in the scene's colours, on a canvas filling the box the server sized for it. */
async function paintArt() {
  const [{ mount }, { chart, fact, score, wordmark, working }] = await Promise.all([
    import('ascii.rest'),
    import('./scene/art'),
  ])
  const entries: [string, Art][] = [
    ['wordmark', wordmark],
    ['working', working],
  ]
  page.facts.forEach(([title, text], index) => entries.push([`fact-${index}`, fact(title, text)]))
  page.charts.forEach(
    (entry, index) => entry && entries.push([`chart-${index}`, chart(entry.data, entry.max)]),
  )
  page.scores.forEach(({ label, value, ours }, index) =>
    entries.push([`score-${index}`, score(label, value, ours)]),
  )
  const byName = Object.fromEntries(entries)
  for (const host of document.querySelectorAll<HTMLElement>('[data-art]')) {
    const art = byName[host.dataset['art']!]
    if (!art) continue
    const piece = art(scene.theme)
    const canvas = document.createElement('canvas')
    host.replaceChildren(canvas)
    mount(canvas, piece, { motion: !reducedMotion })
  }
}

function wireCopy() {
  const button = document.getElementById('copy-install') as HTMLButtonElement
  button.addEventListener('click', async () => {
    const copied = await navigator.clipboard.writeText('npm install ghostty-webgpu').then(
      () => true,
      () => false,
    )
    button.textContent = copied ? '[ copied ]' : '[ select it ]'
    setTimeout(() => (button.textContent = '[ copy ]'), 1600)
  })
}

function wireTabs() {
  const list = document.getElementById('bench-tabs')!
  const tabs = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
  const select = (chosen: HTMLButtonElement) => {
    for (const tab of tabs) {
      const selected = tab === chosen
      tab.setAttribute('aria-selected', String(selected))
      tab.tabIndex = selected ? 0 : -1
      document.getElementById(tab.getAttribute('aria-controls')!)!.hidden = !selected
    }
  }
  list.addEventListener('click', (event) => {
    const tab = (event.target as Element).closest<HTMLButtonElement>('[role="tab"]')
    if (tab) select(tab)
  })
  list.addEventListener('keydown', (event) => {
    const step = TAB_STEPS[event.key]
    if (step === undefined) return
    const current = tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true')
    const next = tabs[(current + step + tabs.length) % tabs.length]!
    select(next)
    next.focus()
  })
}

wireCopy()
wireTabs()
// The scene's terminal and the page's art load side by side; neither waits for the other.
import('./scene/player')
  .then(({ mountScene }) =>
    mountScene(
      document.getElementById('scene')!,
      scene.name as PieceName,
      scene.theme,
      reducedMotion,
    ),
  )
  .catch((cause: unknown) => console.error('The scene did not start', cause))
paintArt().catch((cause: unknown) => console.error('The page art did not draw', cause))

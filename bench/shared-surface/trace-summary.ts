// Summarizes Chrome traces from probe.ts: GPU-process self time per thread and slice name.
// Usage: bun bench/shared-surface/trace-summary.ts <trace.json>... [--top 25]
import { readFileSync } from 'node:fs'

interface TraceEvent {
  readonly ph: string
  readonly pid: number
  readonly tid: number
  readonly ts: number
  readonly dur?: number
  readonly tdur?: number
  readonly name: string
  readonly cat?: string
  readonly args?: { readonly name?: string }
}

interface Open {
  readonly name: string
  readonly start: number
  readonly end: number
  readonly cpu: number
  child: number
  childCpu: number
}

const files = process.argv.slice(2).filter((arg) => arg.endsWith('.json'))
const topIndex = process.argv.indexOf('--top')
const top = topIndex === -1 ? 25 : Number(process.argv[topIndex + 1])

for (const file of files) summarize(file)

function summarize(file: string): void {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as
    | { traceEvents?: TraceEvent[] }
    | TraceEvent[]
  const events = Array.isArray(parsed) ? parsed : (parsed.traceEvents ?? [])
  const gpuPids = new Set(
    events
      .filter(
        (event) =>
          event.ph === 'M' && event.name === 'process_name' && event.args?.name === 'GPU Process',
      )
      .map((event) => event.pid),
  )
  const threadNames = new Map(
    events
      .filter((event) => event.ph === 'M' && event.name === 'thread_name' && gpuPids.has(event.pid))
      .map((event) => [event.tid, event.args?.name ?? String(event.tid)]),
  )
  const complete = events
    .filter((event) => gpuPids.has(event.pid) && event.ph === 'X' && event.dur !== undefined)
    .toSorted((a, b) => a.tid - b.tid || a.ts - b.ts || (b.dur ?? 0) - (a.dur ?? 0))
  const self = new Map<string, { wall: number; cpu: number; count: number }>()
  const window = { start: Infinity, end: -Infinity }
  const stacks = new Map<number, Open[]>()
  const close = (tid: number, open: Open) => {
    const key = `${threadNames.get(tid) ?? tid}\t${open.name}`
    const entry = self.get(key) ?? { wall: 0, cpu: 0, count: 0 }
    entry.wall += open.end - open.start - open.child
    entry.cpu += Math.max(0, open.cpu - open.childCpu)
    entry.count += 1
    self.set(key, entry)
  }
  for (const event of complete) {
    window.start = Math.min(window.start, event.ts)
    window.end = Math.max(window.end, event.ts + event.dur!)
    const stack = stacks.get(event.tid) ?? []
    stacks.set(event.tid, stack)
    while (stack.length > 0 && stack.at(-1)!.end <= event.ts) close(event.tid, stack.pop()!)
    const parent = stack.at(-1)
    const cpu = event.tdur ?? event.dur!
    if (parent) {
      parent.child += event.dur!
      parent.childCpu += cpu
    }
    stack.push({
      name: event.name,
      start: event.ts,
      end: event.ts + event.dur!,
      cpu,
      child: 0,
      childCpu: 0,
    })
  }
  for (const [tid, stack] of stacks) while (stack.length > 0) close(tid, stack.pop()!)
  const seconds = (window.end - window.start) / 1e6
  const perThread = new Map<string, number>()
  for (const [key, entry] of self) {
    const thread = key.split('\t')[0]!
    perThread.set(thread, (perThread.get(thread) ?? 0) + entry.cpu)
  }
  console.log(`# ${file} (${seconds.toFixed(2)} s traced)`)
  for (const [thread, cpu] of Array.from(perThread)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)) {
    console.log(`thread ${thread}: ${((cpu / 1e6 / seconds) * 100).toFixed(1)}% traced CPU`)
  }
  const rows = Array.from(self)
    .sort((a, b) => b[1].cpu - a[1].cpu)
    .slice(0, top)
  for (const [key, entry] of rows) {
    const [thread, name] = key.split('\t')
    const percent = ((entry.cpu / 1e6 / seconds) * 100).toFixed(2)
    console.log(`${percent.padStart(6)}%  ${String(entry.count).padStart(6)}x  ${thread}  ${name}`)
  }
}

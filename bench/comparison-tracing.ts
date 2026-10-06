import type { GhosttyRenderState } from '../src/core/render-state.js'
import type { GhosttyRuntime } from '../src/core/runtime.js'
import type { GhosttyTerminal } from '../src/core/terminal.js'
import type { WebGlTerminalRenderer } from '../src/render/webgl/renderer.js'
import type { RowTerminalRenderer } from '../src/render/row-renderer.js'
import type { WebGpuTerminalRenderer } from '../src/render/renderer.js'

type Category = 'parse' | 'snapshot' | 'damage' | 'instances' | 'upload' | 'commands' | 'js'
interface Span {
  terminal: number
  operation: string
  category: Category
  start: number
  end: number
  self: number
  commands?: readonly number[]
}
type SpanDetails = Pick<Span, 'commands'>
interface Counter {
  terminal: number
  time: number
  operation: string
  value: number
}
type Method = (...args: unknown[]) => unknown

function field(object: unknown, name: string): unknown {
  if (!object || typeof object !== 'object') throw new Error(`Trace object missing: ${name}`)
  const result: unknown = Reflect.get(object, name)
  if (result === undefined) throw new Error(`Pinned trace boundary missing: ${name}`)
  return result
}

export class ComparisonTracing {
  readonly enabled = new URLSearchParams(location.search).has('trace')
  private active = false
  private spans: Span[] = []
  private counters: Counter[] = []
  private markers: { operation: string; time: number; detail?: unknown }[] = []
  private stack: { children: number }[] = []
  private ownership: unknown[] = []
  private runtimes = new Set<GhosttyRuntime>()
  private handles = new Map<number, number>()
  private objects = new Map<unknown, number>()
  private coordinators = new Set<unknown>()
  private gpuOwners = new WeakMap<object, { renderer: WebGpuTerminalRenderer; terminal: number }>()
  private commands = new WeakMap<GPUCommandBuffer, number>()
  private nextCommand = 0

  private commandIdentity(command: unknown): number {
    if (!(command instanceof GPUCommandBuffer))
      throw new Error('Coordinated trace requires its actual GPU command buffer')
    const existing = this.commands.get(command)
    if (existing !== undefined) return existing
    const id = this.nextCommand++
    this.commands.set(command, id)
    return id
  }

  private identity(object: unknown): number {
    const existing = this.objects.get(object)
    if (existing !== undefined) return existing
    const id = this.objects.size
    this.objects.set(object, id)
    return id
  }

  mark(operation: string, detail?: unknown): void {
    if (!this.active) return
    const time = performance.now()
    this.markers.push({ operation, time, detail })
    performance.mark(`compare/${operation}`, { detail })
  }

  count(terminal: number, operation: string, value = 1): void {
    if (this.active) this.counters.push({ terminal, time: performance.now(), operation, value })
  }

  wrap(
    object: unknown,
    name: string,
    terminal: number | ((args: unknown[]) => number),
    category: Category,
    after?: (result: unknown, args: unknown[]) => SpanDetails | void,
    observeInactive = false,
    before?: (args: unknown[]) => void,
  ): void {
    if (!this.enabled) return
    const original = field(object, name)
    if (typeof original !== 'function') throw new Error(`Trace method required: ${name}`)
    // oxlint-disable-next-line typescript/no-this-alias -- Preserve the wrapped method's receiver.
    const recorder = this
    Reflect.set(object as object, name, function (this: unknown, ...args: unknown[]) {
      if (!recorder.active) {
        const result = (original as Method).apply(this, args)
        if (observeInactive) after?.(result, args)
        return result
      }
      before?.(args)
      const start = performance.now()
      const context = { children: 0 }
      let details: SpanDetails | void = undefined
      recorder.stack.push(context)
      try {
        const result = (original as Method).apply(this, args)
        details = after?.(result, args)
        return result
      } finally {
        const end = performance.now()
        recorder.stack.pop()
        const parent = recorder.stack.at(-1)
        if (parent) parent.children += end - start
        recorder.spans.push({
          terminal: typeof terminal === 'number' ? terminal : terminal(args),
          operation: name,
          category,
          start,
          end,
          self: end - start - context.children,
          ...details,
        })
      }
    })
  }

  native(terminal: number, core: GhosttyTerminal, state: GhosttyRenderState): void {
    if (!this.enabled) return
    this.handles.set(core.handle, terminal)
    if (!this.runtimes.has(core.runtime)) {
      const exports = { ...core.runtime.exports }
      Reflect.set(core.runtime, 'exports', exports)
      this.wrap(
        exports,
        'ghostty_terminal_vt_write',
        (args) => this.handles.get(Number(args[0]))!,
        'parse',
      )
      this.runtimes.add(core.runtime)
    }
    this.wrap(core, 'write', terminal, 'js')
    this.wrap(state, 'update', terminal, 'snapshot', () => this.count(terminal, 'stateUpdates'))
    this.wrap(state, 'readRows', terminal, 'snapshot', (result) => {
      const rows = result as { cells: readonly unknown[]; packed?: { length: number } }[]
      this.count(terminal, 'rowsCopied', rows.length)
      this.count(
        terminal,
        'cellsCopied',
        rows.reduce((sum, row) => sum + (row.packed?.length ?? row.cells.length), 0),
      )
    })
    // Frozen comparison runtimes may predate the text-only reader.
    if (typeof Reflect.get(state, 'readTextRows') === 'function') {
      this.wrap(state, 'readTextRows', terminal, 'snapshot', (result) => {
        const rows = result as readonly unknown[]
        this.count(terminal, 'textRowsCopied', rows.length)
        this.count(terminal, 'textCellsCopied', rows.length * core.size.columns)
      })
    }
    this.wrap(state, 'acknowledge', terminal, 'damage')
    this.wrap(
      state,
      'createFrameBuilder',
      terminal,
      'js',
      (builder) => {
        this.wrap(builder, 'build', terminal, 'instances', (result) => {
          this.count(terminal, 'zigBuilds')
          if (result === 0) this.count(terminal, 'zigReadyBuilds')
          if (result === 1) this.count(terminal, 'zigUnsupportedBuilds')
          if (result === 2) this.count(terminal, 'zigMissingGlyphBuilds')
        })
        this.wrap(builder, 'clearGlyphs', terminal, 'instances', () =>
          this.count(terminal, 'zigGlyphIndexClears'),
        )
      },
      true,
    )
  }

  renderer(terminal: number, renderer: WebGpuTerminalRenderer): void {
    if (!this.enabled) return
    const pass = field(renderer, 'textPass')
    const device = field(renderer, 'device')
    const resources = field(pass, 'resources')
    const coordinator: unknown = Reflect.get(renderer, 'coordinator')
    const deviceOwner: unknown = Reflect.get(renderer, 'deviceOwner')
    this.gpuOwners.set(renderer, { renderer, terminal })
    this.ownership.push({
      terminal,
      backend: 'webgpu',
      scheduler: this.identity(field(renderer, 'scheduler')),
      device: this.identity(device),
      queue: this.identity(field(device, 'queue')),
      deviceOwner: deviceOwner ? this.identity(deviceOwner) : undefined,
      coordinator: coordinator ? this.identity(coordinator) : undefined,
      pipelines: ['cellPipeline', 'glyphPipeline'].map((name) =>
        this.identity(field(resources, name)),
      ),
    })
    this.wrap(renderer, 'notifyWrite', terminal, 'js')
    if (coordinator) {
      this.wrap(renderer, 'drawFrame', terminal, 'js')
      this.traceCoordinator(coordinator)
      this.wrap(pass, 'encode', terminal, 'commands', (command) => ({
        commands: [this.commandIdentity(command)],
      }))
    } else this.traceGpuFrames(terminal, renderer)
    this.wrap(renderer, 'rowsToRebuild', terminal, 'damage')
    this.wrap(renderer, 'drawZigFrame', terminal, 'js')
    this.wrap(pass, 'uploadFrame', terminal, 'upload', (result, args) => {
      this.count(terminal, 'buffersWritten', result as number)
      this.count(terminal, 'bufferBytes', field(pass, 'frameUploadedBytes') as number)
      const ranges = args[1] as { cell: { byteLength: number }; glyph: { byteLength: number } }[]
      this.count(
        terminal,
        'canonicalRangeBytes',
        ranges.reduce((sum, range) => sum + range.cell.byteLength + range.glyph.byteLength, 0),
      )
    })
    const atlas = field(renderer, 'atlasTextures')
    this.wrap(atlas, 'sync', terminal, 'upload', (_, args) => {
      const uploads = args[0] as { extent: { width: number; height: number }; kind: string }[]
      this.count(terminal, 'atlasUploads', uploads.length)
      this.count(
        terminal,
        'atlasBytes',
        uploads.reduce(
          (sum, upload) =>
            sum +
            upload.extent.width * upload.extent.height * (upload.kind === 'grayscale' ? 1 : 4),
          0,
        ),
      )
    })
    this.wrap(pass, 'submit', terminal, 'commands', () => {
      this.count(terminal, 'draws', 2)
      this.count(terminal, 'submissions')
    })
  }

  private traceCoordinator(coordinator: unknown): void {
    if (this.coordinators.has(coordinator)) return
    this.coordinators.add(coordinator)
    this.wrap(coordinator, 'submit', -1, 'js', undefined, false, (args) => {
      const frame = args[0]
      const identity = field(frame, 'owner')
      if (!identity || typeof identity !== 'object') throw new Error('GPU frame owner required')
      const owner = this.gpuOwners.get(identity)
      if (!owner) throw new Error('Coordinated trace requires its actual renderer owner')
      const submitted = owner.renderer.metrics.submittedFrames
      const zig = owner.renderer.metrics.zigFrames
      const command = this.commandIdentity(field(frame, 'command'))
      this.wrap(frame, 'commit', owner.terminal, 'js', () => {
        const frames = owner.renderer.metrics.submittedFrames - submitted
        this.count(owner.terminal, 'frames', frames)
        this.count(owner.terminal, 'draws', frames * 2)
        this.count(owner.terminal, 'zigFrames', owner.renderer.metrics.zigFrames - zig)
        return { commands: [command] }
      })
      this.wrap(frame, 'notify', owner.terminal, 'js')
    })
    this.wrap(coordinator, 'submitGroup', -1, 'commands', (result, args) => {
      if (field(result, 'kind') !== 'submitted') return
      if (!Array.isArray(args[1])) throw new Error('Coordinated trace requires submitted frames')
      this.count(-1, 'submissions')
      this.count(-1, 'commandBuffers', args[1].length)
      return { commands: args[1].map((frame) => this.commandIdentity(field(frame, 'command'))) }
    })
  }

  private traceGpuFrames(
    terminal: number,
    renderer: {
      readonly metrics: {
        readonly submittedFrames: number
        readonly zigFrames?: number
      }
    },
  ): void {
    let submittedFrames = 0
    let zigFrames = 0
    this.wrap(
      renderer,
      'drawFrame',
      terminal,
      'js',
      () => {
        const submitted = renderer.metrics.submittedFrames - submittedFrames
        const zig = (renderer.metrics.zigFrames ?? 0) - zigFrames
        if (submitted > 0) this.count(terminal, 'frames', submitted)
        if (zig > 0) this.count(terminal, 'zigFrames', zig)
      },
      false,
      () => {
        submittedFrames = renderer.metrics.submittedFrames
        zigFrames = renderer.metrics.zigFrames ?? 0
      },
    )
  }

  nativeRenderer(terminal: number, renderer: WebGlTerminalRenderer | RowTerminalRenderer): void {
    if (!this.enabled) return
    const backend = field(renderer, 'backend')
    this.ownership.push({
      terminal,
      backend,
      scheduler: this.identity(field(renderer, 'scheduler')),
    })
    this.wrap(renderer, 'notifyWrite', terminal, 'js')
    if (backend === 'webgl2') {
      this.traceGpuFrames(terminal, renderer)
      const pass = field(field(renderer, 'state'), 'pass')
      this.wrap(renderer, 'rowsToRebuild', terminal, 'damage')
      this.wrap(pass, 'syncAtlas', terminal, 'upload')
      const recordUploads = (result: unknown) => {
        if (typeof result === 'number' && result > 0) this.count(terminal, 'instanceUploadBatches')
        this.count(terminal, 'buffersWritten', result as number)
        this.count(terminal, 'bufferBytes', field(pass, 'frameUploadedBytes') as number)
      }
      this.wrap(renderer, 'drawZigFrame', terminal, 'js')
      this.wrap(pass, 'uploadFrame', terminal, 'upload', recordUploads)
      this.wrap(pass, 'submit', terminal, 'commands', () => this.count(terminal, 'submissions'))
      return
    }
    this.wrap(renderer, 'drawFrame', terminal, 'js', () => this.count(terminal, 'frames'))
    this.wrap(renderer, 'rowsToPaint', terminal, 'damage')
    const surface = field(renderer, 'surface')
    if (backend === 'canvas2d') {
      this.wrap(surface, 'paint', terminal, 'commands', () => this.count(terminal, 'rowsPainted'))
      return
    }
    // Each DOM paint replaces its row node; instrument that instance's commit, including fresh rows.
    this.wrap(surface, 'paint', terminal, 'js', undefined, false, (args) => {
      const row = args[0] as { y: number }
      const container = field(surface, 'container') as HTMLElement
      const previous = container.firstElementChild?.children[row.y]
      if (previous)
        this.wrap(previous, 'replaceWith', terminal, 'commands', () =>
          this.count(terminal, 'rowsPainted'),
        )
    })
  }

  legacy(terminal: number, instance: unknown): void {
    if (!this.enabled) return
    const core = field(instance, 'wasmTerm')
    const renderer = field(instance, 'renderer')
    this.ownership.push({
      terminal,
      backend: 'ghostty-web',
      context: this.identity(field(renderer, 'ctx')),
    })
    this.wrap(core, 'write', terminal, 'parse')
    this.wrap(core, 'update', terminal, 'snapshot')
    this.wrap(core, 'getViewport', terminal, 'snapshot')
    this.wrap(renderer, 'render', terminal, 'js', () => this.count(terminal, 'frames'))
    this.wrap(renderer, 'renderLine', terminal, 'commands', () =>
      this.count(terminal, 'rowsPainted'),
    )
  }

  xtermDom(terminal: number, instance: unknown): void {
    if (!this.enabled) return
    const core = field(instance, '_core')
    const service = field(core, '_renderService')
    const renderer = field(field(service, '_renderer'), 'value')
    this.ownership.push({
      terminal,
      backend: 'xterm-dom',
      scheduler: this.identity(field(service, '_renderDebouncer')),
    })
    this.wrap(field(core, '_inputHandler'), 'parse', terminal, 'parse')
    this.wrap(service, 'refreshRows', terminal, 'damage')
    const wrapped = new WeakSet<HTMLElement>()
    const wrapRows = () => {
      const rows = field(renderer, '_rowElements') as HTMLElement[]
      for (const row of rows) {
        if (wrapped.has(row)) continue
        wrapped.add(row)
        this.wrap(row, 'replaceChildren', terminal, 'commands', () =>
          this.count(terminal, 'rowsPainted'),
        )
      }
    }
    wrapRows()
    this.wrap(
      renderer,
      'renderRows',
      terminal,
      'js',
      () => this.count(terminal, 'frames'),
      false,
      wrapRows,
    )
    this.wrap(field(renderer, '_rowFactory'), 'createRow', terminal, 'snapshot')
  }

  xterm(terminal: number, instance: unknown, addon: unknown): void {
    if (!this.enabled) return
    const core = field(instance, '_core')
    this.wrap(field(core, '_inputHandler'), 'parse', terminal, 'parse')
    const service = field(core, '_renderService')
    const renderer = field(addon, '_renderer')
    const gl = field(renderer, '_gl')
    this.ownership.push({
      terminal,
      scheduler: this.identity(field(service, '_renderDebouncer')),
      backend: 'xterm-webgl',
      context: this.identity(gl),
      programs: ['_glyphRenderer', '_rectangleRenderer'].map((name) =>
        this.identity(field(field(field(renderer, name), 'value'), '_program')),
      ),
    })
    this.wrap(renderer, 'renderRows', terminal, 'js', () => this.count(terminal, 'frames'))
    this.wrap(renderer, '_updateModel', terminal, 'snapshot', (_, args) => {
      this.count(terminal, 'stateUpdates')
      this.count(terminal, 'rowsCopied', Number(args[1]) - Number(args[0]) + 1)
    })
    this.wrap(service, 'refreshRows', terminal, 'damage')
    this.wrap(gl, 'bufferData', terminal, 'upload', (_, args) => {
      this.count(terminal, 'buffersWritten')
      const data = args[1] as number | ArrayBufferView
      this.count(terminal, 'bufferBytes', typeof data === 'number' ? data : data.byteLength)
    })
    this.wrap(gl, 'texImage2D', terminal, 'upload', (_, args) => {
      const canvas = args[5] as HTMLCanvasElement
      const bytes =
        args.length === 6 ? canvas.width * canvas.height * 4 : Number(args[3]) * Number(args[4]) * 4
      this.count(terminal, 'atlasUploads')
      this.count(terminal, 'atlasBytes', bytes)
    })
    this.wrap(gl, 'drawElementsInstanced', terminal, 'commands', () =>
      this.count(terminal, 'draws'),
    )
    this.wrap(gl, 'flush', terminal, 'commands', () => this.count(terminal, 'explicitFlushes'))
  }

  begin(): void {
    if (!this.enabled) throw new Error('Tracing requires the trace URL parameter')
    this.spans = []
    this.counters = []
    this.markers = []
    performance.clearMarks()
    performance.clearMeasures()
    this.active = true
    this.mark('begin', { timeOrigin: performance.timeOrigin })
  }

  end() {
    this.mark('end')
    this.active = false
    // Emit timing entries after measurement so trace serialization is outside CPU sampling.
    for (const span of this.spans)
      performance.measure(`compare/${span.terminal}/${span.category}/${span.operation}`, {
        start: span.start,
        end: span.end,
      })
    return {
      timeOrigin: performance.timeOrigin,
      spans: this.spans,
      counters: this.counters,
      markers: this.markers,
      ownership: this.ownership,
    }
  }
}

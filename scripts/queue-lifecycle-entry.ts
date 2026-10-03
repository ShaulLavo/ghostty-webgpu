import { GhosttyRuntime } from '../src/core/runtime.js'
import { fitTerminalFont } from '../src/dom/fit.js'
import { WebGpuTerminalRenderer } from '../src/render/renderer.js'
import type { RenderSchedulerClock } from '../src/render/scheduler.js'

import type { LifecycleCase, LifecycleEvent, LifecycleResult } from './queue-lifecycle-types.js'

const runtime = await GhosttyRuntime.create({ wasm: '/ghostty-vt.wasm', bridge: '/bridge.wasm' })

class LifecycleClock implements RenderSchedulerClock {
  private next = 0
  private readonly frames = new Map<number, () => void>()

  cancelFrame(handle: number): void {
    this.frames.delete(handle)
  }

  clearTimer(): void {}

  requestFrame(callback: () => void): number {
    this.frames.set(++this.next, callback)
    return this.next
  }

  setTimer(): number {
    throw new TypeError('Lifecycle fixtures keep cursor blinking disabled')
  }

  paint(): void {
    const entry = this.frames.entries().next().value
    if (!entry) throw new TypeError('Expected a scheduled lifecycle frame')
    this.frames.delete(entry[0])
    entry[1]()
  }
}

function observeDevice(device: GPUDevice, label: string, events: LifecycleEvent[]) {
  const pending = new Set<number>()
  const emit = window.parent !== window ? window.parent.queueLifecycleEvent : undefined
  let submits = 0
  let writes = 0
  let fence = 0
  const record = (event: string): void => {
    const entry = {
      device: label,
      event,
      pending: pending.size,
      sequence: events.length,
      submits,
      writes,
    }
    events.push(entry)
    emit?.(entry)
  }
  const submit = device.queue.submit.bind(device.queue)
  device.queue.submit = (commands) => {
    submit(commands)
    submits += 1
    record('submit-return')
  }
  const write = device.queue.writeBuffer.bind(device.queue)
  device.queue.writeBuffer = (...args) => {
    write(...args)
    writes += 1
    record('write-return')
  }
  const done = device.queue.onSubmittedWorkDone.bind(device.queue)
  device.queue.onSubmittedWorkDone = () => {
    const id = ++fence
    pending.add(id)
    record(`fence-register-${id}`)
    const completion = done()
    void completion.then(
      () => {
        pending.delete(id)
        record(`fence-resolve-${id}`)
      },
      () => {
        pending.delete(id)
        record(`fence-reject-${id}`)
      },
    )
    // Return the native promise so observation adds no settlement hop.
    return completion
  }
  const destroy = device.destroy.bind(device)
  device.destroy = () => {
    record('destroy-call')
    destroy()
    record('destroy-return')
  }
  void device.lost.then((info) => record(`lost-${info.reason}`))
  device.addEventListener('uncapturederror', (event) =>
    record(`uncaptured-${event.error.constructor.name}`),
  )
  return record
}

function submitReadback(device: GPUDevice, record: (event: string) => void) {
  const input = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  })
  const output = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  device.queue.writeBuffer(input, 0, new Uint32Array([0x463cafe]))
  const encoder = device.createCommandEncoder()
  encoder.copyBufferToBuffer(input, 0, output, 0, 256)
  device.queue.submit([encoder.finish()])
  return {
    async verify(): Promise<void> {
      await output.mapAsync(GPUMapMode.READ)
      const value = new Uint32Array(output.getMappedRange())[0]
      if (value !== 0x463cafe) throw new TypeError('Submitted-work readback changed')
      record('readback-verified')
      output.unmap()
    },
    dispose(): void {
      input.destroy()
      output.destroy()
    },
  }
}

function failPipeline(device: GPUDevice, record: (event: string) => void) {
  const original = device.createRenderPipeline.bind(device)
  const failure = new TypeError('Lifecycle fixture pipeline setup failure')
  device.createRenderPipeline = () => {
    record('pipeline-setup-failure')
    throw failure
  }
  return {
    failure,
    restore: () => {
      device.createRenderPipeline = original
    },
  }
}

async function run(name: LifecycleCase): Promise<LifecycleResult> {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new TypeError('Queue lifecycle requires a WebGPU adapter')
  const events: LifecycleEvent[] = []
  const first = await adapter.requestDevice()
  const recordA = observeDevice(first, 'A', events)
  let second: GPUDevice | undefined
  let recordB: ((event: string) => void) | undefined
  let probeB: ReturnType<typeof submitReadback> | undefined
  if (
    name === 'replacement' ||
    name === 'late-replacement' ||
    name === 'generation-change' ||
    name === 'replacement-failure'
  ) {
    const replacementAdapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance',
    })
    if (!replacementAdapter) throw new TypeError('Replacement adapter was unavailable')
    second = await replacementAdapter.requestDevice()
    recordB = observeDevice(second, 'B', events)
  }
  const clock = new LifecycleClock()
  const canvas = document.createElement('canvas')
  document.body.append(canvas)
  const font = fitTerminalFont(
    document,
    {
      boldWeight: 700,
      family: 'monospace',
      letterSpacing: 0,
      lineHeight: 1.2,
      size: 13,
      weight: 400,
    },
    1,
  )
  const terminal = runtime.createTerminal({
    columns: 8,
    rows: 2,
    cellWidth: font.deviceCellWidth,
    cellHeight: font.deviceCellHeight,
  })
  terminal.write('queue A')
  const state = runtime.createRenderState(terminal)
  const acquired = Promise.withResolvers<GPUDevice>()
  let acquisitions = 0
  const factory = async () => {
    acquisitions += 1
    if (acquisitions === 1) return first
    if (name === 'late-replacement') return acquired.promise
    if (second) return second
    throw new TypeError('Unexpected lifecycle device acquisition')
  }
  const options = {
    canvas,
    columns: 8,
    rows: 2,
    font,
    renderState: state,
    schedulerClock: clock,
    deviceFactory: factory,
  }
  let renderer: WebGpuTerminalRenderer | undefined
  let restorePipeline = () => {}
  let restoreConfigure = () => {}
  try {
    if (name === 'construction-failure') {
      const injection = failPipeline(first, recordA)
      restorePipeline = injection.restore
      let failure: unknown
      try {
        await WebGpuTerminalRenderer.create(options)
      } catch (cause) {
        failure = cause
      }
      if (failure !== injection.failure) {
        throw new TypeError('Construction did not preserve the setup failure')
      }
      recordA('original-setup-error-preserved')
      await first.lost
      return { events, frames: 0, restores: 0 }
    }
    renderer = await WebGpuTerminalRenderer.create(options)
    clock.paint()
    const completionA = first.queue.onSubmittedWorkDone()
    if (name === 'submitted-work') {
      const probe = submitReadback(first, recordA)
      try {
        const secondFence = first.queue.onSubmittedWorkDone()
        const thirdFence = first.queue.onSubmittedWorkDone()
        recordA('known-good-pending')
        await Promise.all([completionA, secondFence, thirdFence, probe.verify()])
        recordA('ready-fence-start')
        await first.queue.onSubmittedWorkDone()
        recordA('ready-fence-settled')
      } finally {
        probe.dispose()
      }
    }
    if (name === 'replacement') {
      recordA('replacement-start')
      await renderer.simulateDeviceLoss()
      clock.paint()
      if (!second || !recordB) throw new TypeError('Replacement device was not acquired')
      const probe = submitReadback(second, recordB)
      try {
        await probe.verify()
      } finally {
        probe.dispose()
      }
      await completionA.catch(() => {})
    }
    if (name === 'late-replacement') {
      if (!second || !recordB) throw new TypeError('Late replacement device was not acquired')
      probeB = submitReadback(second, recordB)
      const completionB = second.queue.onSubmittedWorkDone()
      const restoring = renderer.simulateDeviceLoss()
      renderer.dispose()
      recordB('late-acquisition-resolve')
      acquired.resolve(second)
      await restoring
      await Promise.all([completionA.catch(() => {}), completionB.catch(() => {}), second.lost])
    }
    if (name === 'generation-change') {
      if (!second || !recordB) throw new TypeError('Generation device was not acquired')
      probeB = submitReadback(second, recordB)
      const completionB = second.queue.onSubmittedWorkDone()
      const context = canvas.getContext('webgpu')
      if (!context) throw new TypeError('Expected a lifecycle WebGPU context')
      const configure = context.configure.bind(context)
      context.configure = (configuration) => {
        recordB?.('dispose-during-configure')
        renderer?.dispose()
        configure(configuration)
      }
      restoreConfigure = () => {
        context.configure = configure
      }
      await renderer.simulateDeviceLoss()
      await Promise.all([completionA.catch(() => {}), completionB.catch(() => {}), second.lost])
    }
    if (name === 'replacement-failure') {
      if (!second || !recordB) throw new TypeError('Failed replacement device was not acquired')
      restorePipeline = failPipeline(second, recordB).restore
      await renderer.simulateDeviceLoss()
      await Promise.all([completionA.catch(() => {}), second.lost])
    }
    if (name === 'external-destroy') {
      renderer.dispose()
      recordA('external-destroy-start')
      first.destroy()
      await Promise.all([completionA.catch(() => {}), first.lost])
    }
    if (name === 'realm-removal') {
      renderer.dispose()
      recordA('realm-removal-armed')
      window.parent.queueLifecycleRemove?.()
      recordA('realm-removal-returned')
      return {
        events,
        frames: renderer.metrics.submittedFrames,
        restores: 0,
      }
    }
    return {
      events,
      frames: renderer.metrics.submittedFrames,
      restores: renderer.metrics.deviceRestores,
    }
  } finally {
    if (name !== 'realm-removal') {
      restorePipeline()
      restoreConfigure()
      renderer?.dispose()
      await first.queue.onSubmittedWorkDone().catch(() => {})
      first.destroy()
      if (second) {
        await second.queue.onSubmittedWorkDone().catch(() => {})
        second.destroy()
        await second.lost
      }
      probeB?.dispose()
      state.dispose()
      terminal.dispose()
      canvas.remove()
      await first.lost
    }
  }
}

window.queueLifecycle = { run }

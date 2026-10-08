export interface DeviceLifecycleCounts {
  readonly device: number
  waits: number
  destroys: number
}

export function observeDevice(device: GPUDevice, identity: number): DeviceLifecycleCounts {
  const counts = { device: identity, waits: 0, destroys: 0 }
  const wait = device.queue.onSubmittedWorkDone.bind(device.queue)
  device.queue.onSubmittedWorkDone = () => {
    counts.waits += 1
    return wait()
  }
  const destroy = device.destroy.bind(device)
  device.destroy = () => {
    counts.destroys += 1
    destroy()
  }
  return counts
}

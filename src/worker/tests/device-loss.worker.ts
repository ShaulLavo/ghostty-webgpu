import '../../../dist/worker/entry.js'

export type DeviceObservation =
  | { readonly type: 'armed' }
  | { readonly type: 'acquired'; readonly device: number; readonly backend: string }
  | { readonly type: 'lost'; readonly device: number; readonly reason: string }
  | { readonly type: 'pixels'; readonly device: number; readonly pixels: readonly number[] }

const channel = new BroadcastChannel('packaged-worker-device-loss')
const devices: GPUDevice[] = []
let texture: GPUTexture | undefined
let capture = false
const getCurrentTexture = GPUCanvasContext.prototype.getCurrentTexture
GPUCanvasContext.prototype.getCurrentTexture = function () {
  texture = getCurrentTexture.call(this)
  return texture
}

async function capturePixels(device: GPUDevice, current: GPUTexture): Promise<void> {
  const bytesPerRow = Math.ceil((current.width * 4) / 256) * 256
  const buffer = device.createBuffer({
    size: bytesPerRow * current.height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  const encoder = device.createCommandEncoder()
  encoder.copyTextureToBuffer(
    { texture: current },
    { buffer, bytesPerRow },
    { width: current.width, height: current.height },
  )
  device.queue.submit([encoder.finish()])
  try {
    await buffer.mapAsync(GPUMapMode.READ)
    const pixels = Array.from(new Uint8Array(buffer.getMappedRange()))
    channel.postMessage({ type: 'pixels', device: devices.indexOf(device), pixels })
  } finally {
    buffer.destroy()
  }
}

const requestDevice = GPUAdapter.prototype.requestDevice
GPUAdapter.prototype.requestDevice = async function (descriptor) {
  const device = await requestDevice.call(this, descriptor)
  const index = devices.push(device) - 1
  channel.postMessage({ type: 'acquired', device: index, backend: this.info.description })
  void device.lost.then((loss) =>
    channel.postMessage({ type: 'lost', device: index, reason: loss.reason }),
  )
  const submit = device.queue.submit.bind(device.queue)
  device.queue.submit = (commands) => {
    submit(commands)
    if (!capture || !texture) return
    capture = false
    void capturePixels(device, texture)
  }
  return device
}

channel.onmessage = ({ data }: MessageEvent<'capture' | 'destroy'>) => {
  capture = true
  channel.postMessage({ type: 'armed' })
  if (data === 'destroy') devices.at(-1)?.destroy()
}

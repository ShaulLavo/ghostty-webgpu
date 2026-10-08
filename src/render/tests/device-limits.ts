import { onTestFinished, vi } from 'vitest'

type BufferLimits = Pick<GPUSupportedLimits, 'maxBufferSize' | 'maxStorageBufferBindingSize'>

export function limitDeviceBuffers(device: GPUDevice, limits: Partial<BufferLimits>): void {
  const actual = device.limits
  const getter = vi.spyOn(device, 'limits', 'get').mockReturnValue(
    new Proxy(actual, {
      get(target, key) {
        if (key === 'maxBufferSize' || key === 'maxStorageBufferBindingSize') {
          return limits[key] ?? Reflect.get(target, key, target)
        }
        return Reflect.get(target, key, target)
      },
    }),
  )
  onTestFinished(() => getter.mockRestore())
}

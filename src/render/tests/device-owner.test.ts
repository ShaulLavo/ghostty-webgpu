import { expect, it, vi } from 'vitest'
import { DeviceOwner } from '../device-owner.js'

function deviceFixture() {
  const loss = Promise.withResolvers<Pick<GPUDeviceLostInfo, 'message' | 'reason'>>()
  const fence = Promise.withResolvers<void>()
  const destroy = vi.fn(() => loss.resolve({ reason: 'destroyed', message: '' }))
  const device = {
    lost: loss.promise,
    destroy,
    queue: { onSubmittedWorkDone: () => fence.promise },
  } as unknown as GPUDevice
  return { device, loss, fence, destroy }
}

it('deduplicates pending acquisition and releases only after the last lease fence', async () => {
  const fixture = deviceFixture()
  const factory = vi.fn(async () => fixture.device)
  const owner = new DeviceOwner(factory)
  const [first, second] = await Promise.all([owner.acquire(), owner.acquire()])
  expect(factory).toHaveBeenCalledOnce()
  expect(first.device).toBe(second.device)
  await first.release()
  await first.release()
  expect(fixture.destroy).not.toHaveBeenCalled()
  const closed = second.release()
  expect(second.release()).toBe(closed)
  expect(fixture.destroy).not.toHaveBeenCalled()
  fixture.fence.resolve()
  await closed
  expect(fixture.destroy).toHaveBeenCalledOnce()
})

it('retiring one lease retains peers and cannot retire the replacement generation', async () => {
  const old = deviceFixture(),
    next = deviceFixture()
  const factory = vi.fn().mockResolvedValueOnce(old.device).mockResolvedValue(next.device)
  const owner = new DeviceOwner(factory)
  const [first, peer] = await Promise.all([owner.acquire(), owner.acquire()])
  first.retire()
  const replacement = await owner.acquire()
  peer.retire()
  const nextPeer = await owner.acquire()
  expect(replacement.device).toBe(nextPeer.device)
  expect(factory).toHaveBeenCalledTimes(2)
  await first.release()
  expect(old.destroy).not.toHaveBeenCalled()
  old.fence.resolve()
  await peer.release()
  expect(old.destroy).toHaveBeenCalledOnce()
  expect(next.destroy).not.toHaveBeenCalled()
  await replacement.release()
  next.fence.resolve()
  await nextPeer.release()
})

it('recovers one shared generation after device loss and keeps failure retryable', async () => {
  const old = deviceFixture(),
    next = deviceFixture()
  const factory = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('acquisition failed'))
    .mockResolvedValueOnce(old.device)
    .mockResolvedValue(next.device)
  const owner = new DeviceOwner(factory)
  await expect(owner.acquire()).rejects.toThrow('acquisition failed')
  const [first, second] = await Promise.all([owner.acquire(), owner.acquire()])
  old.loss.resolve({ reason: 'unknown', message: '' })
  await old.loss.promise
  const [replacement, peer] = await Promise.all([owner.acquire(), owner.acquire()])
  expect(replacement.device).toBe(peer.device)
  expect(replacement.device).not.toBe(first.device)
  expect(factory).toHaveBeenCalledTimes(3)
  old.fence.resolve()
  await Promise.all([first.release(), second.release()])
  next.fence.resolve()
  await Promise.all([replacement.release(), peer.release()])
})

it('a reopen during the final fence owns a fresh generation', async () => {
  const old = deviceFixture(),
    next = deviceFixture()
  const factory = vi.fn().mockResolvedValueOnce(old.device).mockResolvedValue(next.device)
  const owner = new DeviceOwner(factory)
  const first = await owner.acquire()
  const closed = first.release()
  const reopened = await owner.acquire()
  expect(reopened.device).toBe(next.device)
  old.fence.resolve()
  await closed
  expect(next.destroy).not.toHaveBeenCalled()
  next.fence.resolve()
  await reopened.release()
})

it('reserves a pending peer before the old last lease can retire or destroy its device', async () => {
  const fixture = deviceFixture()
  const factory = vi.fn(async () => fixture.device)
  const owner = new DeviceOwner(factory)
  const oldLease = await owner.acquire()
  fixture.fence.resolve()
  const peerPromise = owner.acquire()
  await oldLease.release()
  const peer = await peerPromise
  expect(factory).toHaveBeenCalledOnce()
  expect(peer.device).toBe(oldLease.device)
  expect(fixture.destroy).not.toHaveBeenCalled()
  await peer.release()
  expect(fixture.destroy).toHaveBeenCalledOnce()
})

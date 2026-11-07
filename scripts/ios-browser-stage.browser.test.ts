import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

const calls: string[] = []
let element: HTMLDivElement
beforeAll(() => {
  calls.push('beforeAll')
  element = document.createElement('div')
})
afterEach(() => {
  calls.push('afterEach')
  element.remove()
})
afterAll(() => {
  expect(calls).toEqual(['beforeAll', 'test', 'afterEach'])
})
describe('framework staging', () => {
  test('completes normal hooks and logical viewport', () => {
    expect(calls).toEqual(['beforeAll'])
    calls.push('test')
    document.body.append(element)
    expect(element.isConnected).toBe(true)
    expect(window.innerWidth).toBe(414)
    expect(window.innerHeight).toBe(896)
    expect(Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0).toBe(true)
  })
})

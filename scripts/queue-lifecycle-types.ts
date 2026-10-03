export const lifecycleCases = [
  'submitted-work',
  'replacement',
  'late-replacement',
  'generation-change',
  'construction-failure',
  'replacement-failure',
  'external-destroy',
  'realm-removal',
] as const

export type LifecycleCase = (typeof lifecycleCases)[number]

export interface LifecycleEvent {
  device: string
  event: string
  pending: number
  sequence: number
  submits: number
  writes: number
}

export interface LifecycleResult {
  events: LifecycleEvent[]
  frames: number
  restores: number
}

export interface LifecycleHarness {
  run(name: LifecycleCase): Promise<LifecycleResult>
}

declare global {
  interface Window {
    queueLifecycle: LifecycleHarness
    queueLifecycleEvent?: (event: LifecycleEvent) => void
    queueLifecycleRemove?: () => void
    queueLifecycleRealmEvents?: LifecycleEvent[]
  }
}

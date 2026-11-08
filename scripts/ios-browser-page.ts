import type { RunnerTask, RunnerTaskResultPack, SerializedConfig } from 'vitest'
import {
  getFrameworkObservation,
  type FrameworkObservation,
} from 'waffle/testing/page-runner/framework-page'
import { errorJson, frameworkTasks, frameworkUpdates, taskUpdate } from './ios-browser-records.ts'

function observe(
  operation: (observation: FrameworkObservation) => Promise<void> | void,
): Promise<void> | undefined {
  try {
    const observation = getFrameworkObservation()
    if (!observation || observation.signal.aborted) return
    return operation(observation)?.catch(() => {})
  } catch {
    // Reporting failure must not replace an official framework outcome.
    return
  }
}

export function collected(
  tasks: readonly RunnerTask[],
  config: SerializedConfig,
): Promise<void> | undefined {
  return observe((observation) => observation.collected(() => frameworkTasks(tasks, config)))
}

export function taskStarted(task: RunnerTask): Promise<void> | undefined {
  return observe((observation) => observation.taskStarted(() => task.id))
}

export function taskUpdated(packs: readonly RunnerTaskResultPack[]): void {
  observe((observation) => observation.taskUpdate(() => frameworkUpdates(packs)))
}

export function caseSettled(task: RunnerTask): Promise<void> | undefined {
  return observe((observation) =>
    observation.caseSettled(() => {
      if (task.type !== 'test') return null
      const result = task.result
      if (!result) return null
      return [taskUpdate(task.id, result)]
    }),
  )
}

export function caughtError(error: unknown, source: string): void {
  observe((observation) => observation.error(() => ({ error: errorJson(error), source })))
}

export function executionFlushed(): Promise<void> | undefined {
  return observe((observation) => observation.executionFlushed())
}

export function testerCleanupSettled(): Promise<void> | undefined {
  return observe((observation) => observation.testerCleanupSettled())
}

export function catcherInstalled(): void {
  observe((observation) => observation.catcherInstalled())
}

export async function cleanupResponseReceived(): Promise<void> {
  await observe((observation) => observation.cleanupResponseReceived())
  await observe((observation) => observation.waitForRetirement())
}

export async function initialViewport(): Promise<
  Awaited<ReturnType<FrameworkObservation['waitForInitialViewport']>> | undefined
> {
  return getFrameworkObservation()?.waitForInitialViewport()
}

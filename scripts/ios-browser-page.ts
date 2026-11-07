import type { RunnerTask, RunnerTaskResultPack, SerializedConfig } from 'vitest'
import {
  getFrameworkObservation,
  type FrameworkObservation,
} from 'waffle/testing/page-runner/framework-page'
import { errorJson, frameworkTasks, frameworkUpdates, taskUpdate } from './ios-browser-records.ts'

function observe(operation: (observation: FrameworkObservation) => void): void {
  const observation = getFrameworkObservation()
  if (!observation) return
  try {
    operation(observation)
  } catch (error) {
    // Conversion faults remain failures without preventing ordinary framework RPC.
    observation.error({ message: String(error) }, 'Ghostty observation')
  }
}

export async function collected(
  tasks: readonly RunnerTask[],
  config: SerializedConfig,
): Promise<void> {
  const observation = getFrameworkObservation()
  if (!observation) return
  await observation.collected(frameworkTasks(tasks, config))
}

export function taskStarted(task: RunnerTask): void {
  observe((observation) => observation.taskStarted(task.id))
}

export function taskUpdated(packs: readonly RunnerTaskResultPack[]): void {
  observe((observation) => observation.taskUpdate(frameworkUpdates(packs)))
}

export function caseSettled(task: RunnerTask): void {
  if (task.type !== 'test' || !task.result) return
  const result = task.result
  observe((observation) => observation.caseSettled([taskUpdate(task.id, result)]))
}

export function caughtError(error: unknown, source: string): void {
  observe((observation) => observation.error(errorJson(error), source))
}

export function executionFlushed(): void {
  observe((observation) => observation.executionFlushed())
}

export function testerCleanupSettled(): void {
  observe((observation) => observation.testerCleanupSettled())
}

export function catcherInstalled(): void {
  observe((observation) => observation.catcherInstalled())
}

export async function cleanupResponseReceived(): Promise<void> {
  const observation = getFrameworkObservation()
  if (!observation) return
  observation.cleanupResponseReceived()
  await observation.waitForRetirement()
}

export async function initialViewport(): Promise<
  Awaited<ReturnType<FrameworkObservation['waitForInitialViewport']>> | undefined
> {
  return getFrameworkObservation()?.waitForInitialViewport()
}

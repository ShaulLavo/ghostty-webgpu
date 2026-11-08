import type { RunnerTask, RunnerTaskResult, RunnerTaskResultPack, SerializedConfig } from 'vitest'
import type {
  FrameworkTask,
  FrameworkUpdate,
  Json,
} from 'waffle/testing/page-runner/framework-page'

export function errorJson(value: unknown, ancestors = new Set<object>()): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object') throw new TypeError('Non-JSON framework error value')
  if (ancestors.has(value)) throw new TypeError('Circular framework error value')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => errorJson(item, ancestors))
    return objectErrorJson(value, ancestors)
  } finally {
    ancestors.delete(value)
  }
}

function objectErrorJson(value: object, ancestors: Set<object>): Json {
  const result: Record<string, Json> = {}
  if (value instanceof Error && !Object.hasOwn(value, 'name')) result.name = value.name
  for (const key of Object.getOwnPropertyNames(value)) {
    const item: unknown = Reflect.get(value, key)
    if (item === undefined) continue
    result[key] = errorJson(item, ancestors)
  }
  return result
}

function retries(task: RunnerTask, config: SerializedConfig): number {
  const retry = task.retry ?? config.retry
  return typeof retry === 'number' ? retry : (retry.count ?? 0)
}

export function frameworkTasks(
  tasks: readonly RunnerTask[],
  config: SerializedConfig,
  parentId: string | null = null,
): FrameworkTask[] {
  return tasks.flatMap((task) => {
    const file = 'filepath' in task
    const id = task.id
    const type = task.type
    const record: FrameworkTask = {
      id,
      parentId,
      type: file ? 'file' : type,
      file: file ? task.filepath : task.file.filepath,
      fullName: task.fullTestName ?? task.name,
      mode: task.mode,
      timeoutMs: type === 'test' ? task.timeout : config.hookTimeout,
      retries: retries(task, config),
    }
    if (type === 'test') return [record]
    return [record].concat(frameworkTasks(task.tasks, config, id))
  })
}

function updateState(state: RunnerTaskResult['state']): FrameworkUpdate['state'] {
  switch (state) {
    case 'run':
    case 'pass':
    case 'fail':
    case 'skip':
    case 'todo':
      return state
    case 'only':
    case 'queued':
      throw new Error(`Unsupported installed Vitest update state: ${state}`)
    default: {
      const exhaustive: never = state
      return exhaustive
    }
  }
}

export function taskUpdate(id: string, result: RunnerTaskResult): FrameworkUpdate {
  return {
    id,
    state: updateState(result.state),
    errors: (result.errors ?? []).map((error) => errorJson(error)),
    hooks: errorJson(result.hooks ?? {}),
    retryCount: result.retryCount ?? 0,
  }
}

export function frameworkUpdates(packs: readonly RunnerTaskResultPack[]): FrameworkUpdate[] {
  return packs.flatMap(([id, result]) => (result ? [taskUpdate(id, result)] : []))
}

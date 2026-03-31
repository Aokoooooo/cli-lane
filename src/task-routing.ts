export type TaskSerialMode = 'global' | 'by-cwd'
export type TaskMergeModeValue = 'by-cwd' | 'global' | 'off'

export type LaneRoutedTask = {
  serialMode: TaskSerialMode
  mergeMode: TaskMergeModeValue
  serialKey: string
}

export type MergeRoutedTask = {
  cwd: string
  argv: string[]
  mergeMode: TaskMergeModeValue
}

export function normalizeSerialMode(value: unknown): TaskSerialMode {
  return value === 'by-cwd' ? 'by-cwd' : 'global'
}

export function normalizeMergeMode(value: unknown): TaskMergeModeValue {
  return value === 'global' || value === 'off' ? value : 'by-cwd'
}

export function resolveSerialKey(
  serialMode: TaskSerialMode,
  cwd: string,
): string {
  return serialMode === 'global' ? '__global__' : cwd
}

export function resolveLaneKey(task: LaneRoutedTask): string {
  if (task.mergeMode === 'global' || task.serialMode === 'global') {
    return 'global'
  }

  return task.serialKey
}

export function resolveMergeKey(task: MergeRoutedTask): string | undefined {
  const argvKey = JSON.stringify(task.argv)

  if (task.mergeMode === 'off') {
    return undefined
  }

  if (task.mergeMode === 'global') {
    return `global:${argvKey}`
  }

  return `cwd:${task.cwd}:${argvKey}`
}

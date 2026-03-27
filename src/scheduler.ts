import { resolveLaneKey } from './task-routing'

export type SchedulerTask = {
  taskId: string
  serialMode: 'global' | 'by-cwd'
  mergeMode: 'by-cwd' | 'global' | 'off'
  serialKey: string
}

type LaneState = {
  queue: SchedulerTask[]
  runningTaskId?: string
}

export class Scheduler {
  private readonly lanes = new Map<string, LaneState>()
  private readonly tasks = new Map<
    string,
    { task: SchedulerTask; laneKey: string }
  >()

  enqueue(task: SchedulerTask): boolean {
    if (this.tasks.has(task.taskId)) {
      return false
    }

    const laneKey = resolveLaneKey(task)
    const lane = this.getLane(laneKey)

    lane.queue.push(task)
    this.tasks.set(task.taskId, { task, laneKey })
    return true
  }

  nextRunnableFor(
    taskLike: Pick<SchedulerTask, 'serialMode' | 'mergeMode' | 'serialKey'>,
  ): SchedulerTask | undefined {
    return this.nextRunnable(resolveLaneKey(taskLike))
  }

  nextRunnable(serialKey: string): SchedulerTask | undefined {
    const lane = this.lanes.get(serialKey)

    if (!lane || lane.runningTaskId || lane.queue.length === 0) {
      return undefined
    }

    return lane.queue[0]
  }

  markRunning(taskId: string): boolean {
    const entry = this.tasks.get(taskId)

    if (!entry) {
      return false
    }

    const lane = this.lanes.get(entry.laneKey)

    if (!lane || lane.runningTaskId || lane.queue[0]?.taskId !== taskId) {
      return false
    }

    lane.runningTaskId = taskId
    return true
  }

  markFinished(taskId: string): boolean {
    const entry = this.tasks.get(taskId)

    if (!entry) {
      return false
    }

    const lane = this.lanes.get(entry.laneKey)

    if (!lane) {
      return false
    }

    if (lane.runningTaskId !== taskId || lane.queue[0]?.taskId !== taskId) {
      return false
    }

    lane.queue.shift()
    lane.runningTaskId = undefined
    this.tasks.delete(taskId)
    return true
  }
  private getLane(laneKey: string): LaneState {
    const existing = this.lanes.get(laneKey)

    if (existing) {
      return existing
    }

    const created: LaneState = { queue: [] }
    this.lanes.set(laneKey, created)
    return created
  }
}

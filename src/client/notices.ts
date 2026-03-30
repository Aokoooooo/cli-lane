import type { ServerToClient } from '../protocol'

export type ClientNotice =
  | {
      type: 'notice'
      kind: 'subscription-detached'
      message: string
      taskId: string
      subscriberId: string
      remainingSubscribers: number
      taskStillRunning: boolean
    }
  | {
      type: 'notice'
      kind: 'cwd-mismatch'
      message: string
      taskId: string
      executionCwd: string
      requestedCwd: string
    }
  | {
      type: 'notice'
      kind: 'queued'
      message: string
      taskId: string
      position: number
    }
  | {
      type: 'notice'
      kind: 'merged-output-preferences'
      message: string
      taskId: string
    }

export function emitNotice(
  onNotice: ((notice: ClientNotice) => void) | undefined,
  message: ServerToClient,
): void {
  if (!onNotice) {
    return
  }

  if (
    message.type === 'accepted' &&
    message.executionCwd !== message.requestedCwd
  ) {
    onNotice({
      type: 'notice',
      kind: 'cwd-mismatch',
      message: `Task ${message.taskId} is executing in ${message.executionCwd}; your requested cwd was ${message.requestedCwd}.`,
      taskId: message.taskId,
      executionCwd: message.executionCwd,
      requestedCwd: message.requestedCwd,
    })
  }

  if (
    message.type === 'notice' &&
    message.kind === 'merged-output-preferences'
  ) {
    onNotice({
      type: 'notice',
      kind: 'merged-output-preferences',
      message: message.message,
      taskId: message.taskId,
    })
  }

  if (message.type === 'task-event' && message.event.type === 'queued') {
    onNotice({
      type: 'notice',
      kind: 'queued',
      message: `Task ${message.taskId} is queued at position ${message.event.position}.`,
      taskId: message.taskId,
      position: message.event.position,
    })
    return
  }

  if (message.type === 'subscription-detached') {
    onNotice({
      type: 'notice',
      kind: 'subscription-detached',
      message: message.taskStillRunning
        ? `Detached from task ${message.taskId}; ${message.remainingSubscribers} subscriber(s) remain.`
        : `Detached from task ${message.taskId}; task is no longer running.`,
      taskId: message.taskId,
      subscriberId: message.subscriberId,
      remainingSubscribers: message.remainingSubscribers,
      taskStillRunning: message.taskStillRunning,
    })
  }
}

import type { OutputBuffer, OutputChunk, OutputStreamName } from "../output-buffer";
import type { SchedulerTask } from "../scheduler";
import { resolveLaneKey } from "../task-routing";
import type { PsTask, ServerToClient, TaskEvent } from "../protocol";
import type { ServerRuntime, Session, TaskRuntimeState } from "./types";

export function appendOutput(
  runtime: ServerRuntime,
  taskId: string,
  stream: OutputStreamName,
  data: string,
): void {
  const taskState = runtime.taskStates.get(taskId);
  if (!taskState) {
    return;
  }

  const chunk = taskState.buffer.append(stream, data);
  broadcastOutputChunk(runtime, taskId, chunk);
}

export function replayBufferedOutput(session: Session, taskId: string, buffer: OutputBuffer): void {
  const lastSeq = buffer.lastSeq();
  if (lastSeq === 0) {
    return;
  }

  session.replays.set(taskId, {
    lastSeq,
    pending: [],
  });

  for (const chunk of buffer.snapshotUntil(lastSeq)) {
    sendTaskEvent(session, taskId, chunkToEvent(chunk, true));
  }

  const replay = session.replays.get(taskId);
  if (!replay) {
    return;
  }

  for (const pending of replay.pending) {
    send(session, pending);
  }

  session.replays.delete(taskId);
}

export function emitCancelled(runtime: ServerRuntime, taskState: TaskRuntimeState): void {
  if (taskState.terminalEventSent) {
    return;
  }

  taskState.terminalEventSent = true;
  broadcastTaskEvent(runtime, taskState.taskId, { type: "cancelled" });
}

export function finalizeTask(
  runtime: ServerRuntime,
  taskId: string,
  onDrainScheduler: (taskLike: Pick<SchedulerTask, "serialMode" | "mergeMode" | "serialKey">) => void,
): void {
  const taskState = runtime.taskStates.get(taskId);
  if (!taskState) {
    return;
  }

  runtime.scheduler.markFinished(taskId);
  dequeueLaneTask(runtime, taskState);
  runtime.taskStates.delete(taskId);
  if (!runtime.stopped) {
    onDrainScheduler(toSchedulerTask(taskState));
  }
}

export function findTaskPsView(
  runtime: ServerRuntime,
  task: {
    taskId: string;
    status: "queued" | "running";
    canonicalExecutionCwd: string;
    argv: string[];
    subscriberCount: number;
  },
): PsTask {
  const queuePosition = task.status === "queued" ? queuePositionFor(runtime, task.taskId) : undefined;

  return {
    taskId: task.taskId,
    status: task.status,
    cwd: task.canonicalExecutionCwd,
    argv: task.argv,
    subscriberCount: task.subscriberCount,
    merged: task.subscriberCount > 1,
    ...(queuePosition !== undefined ? { queuePosition } : {}),
  };
}

export function queuePositionFor(runtime: ServerRuntime, taskId: string): number | undefined {
  for (const taskIds of runtime.laneQueues.values()) {
    const index = taskIds.indexOf(taskId);
    if (index !== -1) {
      return index + 1;
    }
  }

  return undefined;
}

export function enqueueLaneTask(runtime: ServerRuntime, taskState: TaskRuntimeState): void {
  const laneKey = resolveLaneKey(taskState);
  const taskIds = runtime.laneQueues.get(laneKey) ?? [];
  taskIds.push(taskState.taskId);
  runtime.laneQueues.set(laneKey, taskIds);
}

export function addTaskSession(runtime: ServerRuntime, taskId: string, session: Session): void {
  const sessions = runtime.taskSessions.get(taskId) ?? new Set<Session>();
  sessions.add(session);
  runtime.taskSessions.set(taskId, sessions);
}

export function removeTaskSession(runtime: ServerRuntime, taskId: string, session: Session): void {
  const sessions = runtime.taskSessions.get(taskId);
  if (!sessions) {
    return;
  }

  sessions.delete(session);
  if (sessions.size === 0) {
    runtime.taskSessions.delete(taskId);
  }
}

export function send(session: Session, message: ServerToClient): void {
  session.socket.write(JSON.stringify(message) + "\n");
}

export function sendTaskEvent(session: Session, taskId: string, event: TaskEvent): void {
  send(session, {
    type: "task-event",
    taskId,
    event,
  });
}

export function broadcastTaskEvent(runtime: ServerRuntime, taskId: string, event: TaskEvent): void {
  const sessions = runtime.taskSessions.get(taskId);
  if (!sessions) {
    return;
  }

  for (const session of sessions) {
    sendTaskEvent(session, taskId, event);
  }
}

function dequeueLaneTask(runtime: ServerRuntime, taskState: TaskRuntimeState): void {
  const laneKey = resolveLaneKey(taskState);
  const taskIds = runtime.laneQueues.get(laneKey);
  if (!taskIds) {
    return;
  }

  const index = taskIds.indexOf(taskState.taskId);
  if (index === -1) {
    return;
  }

  taskIds.splice(index, 1);
  if (taskIds.length === 0) {
    runtime.laneQueues.delete(laneKey);
  }
}

function toSchedulerTask(taskState: TaskRuntimeState): SchedulerTask {
  return {
    taskId: taskState.taskId,
    serialMode: taskState.serialMode,
    mergeMode: taskState.mergeMode,
    serialKey: taskState.serialKey,
  };
}

function broadcastOutputChunk(runtime: ServerRuntime, taskId: string, chunk: OutputChunk): void {
  const sessions = runtime.taskSessions.get(taskId);
  if (!sessions) {
    return;
  }

  for (const session of sessions) {
    const replay = session.replays.get(taskId);
    const message: ServerToClient = {
      type: "task-event",
      taskId,
      event: chunkToEvent(chunk, false),
    };

    if (replay) {
      if (chunk.seq <= replay.lastSeq) {
        continue;
      }

      replay.pending.push(message);
      continue;
    }

    send(session, message);
  }
}

function chunkToEvent(chunk: OutputChunk, replay: boolean): TaskEvent {
  return {
    type: chunk.stream,
    data: chunk.data,
    seq: chunk.seq,
    ts: chunk.ts,
    bytes: chunk.bytes,
    replay,
  };
}

import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { OutputBuffer, type OutputChunk } from "./output-buffer";
import { normalizeCwd } from "./path-utils";
import {
  decodeMessageChunk,
  encodeMessage,
  protocolVersion,
  type PsTask,
  type RunMessage,
  type ServerToClient,
  type TaskEvent,
} from "./protocol";
import { runProcess } from "./process-runner";
import { acquireStartupLock, removeRegistration, type Registration, writeRegistration } from "./registry";
import { Scheduler, type SchedulerTask } from "./scheduler";
import { TaskManager, type TaskMergeMode, type TaskSnapshot } from "./task-manager";

export type StartServerOptions = {
  runtimeDir: string;
  serverVersion?: string;
  terminateGraceMs?: number;
  idleTimeoutMs?: number;
  maxBufferedOutputBytes?: number;
  heartbeatTimeoutMs?: number;
};

export type CoordinatorServer = {
  port: number;
  registrationPath: string;
  registration: Registration;
  stop: () => Promise<void>;
};

type ReplayState = {
  lastSeq: number;
  pending: ServerToClient[];
};

type Session = {
  socket: any;
  buffer: string;
  authed: boolean;
  closed: boolean;
  subscriptions: Map<string, string>;
  replays: Map<string, ReplayState>;
  heartbeatTimer: Timer | null;
  handshakeTimer: Timer | null;
};

type TaskRuntimeState = {
  taskId: string;
  serialMode: "global" | "by-cwd";
  mergeMode: TaskMergeMode;
  serialKey: string;
  controller: AbortController;
  buffer: OutputBuffer;
  terminalEventSent: boolean;
};

type ServerRuntime = {
  taskManager: TaskManager;
  scheduler: Scheduler;
  taskStates: Map<string, TaskRuntimeState>;
  sessions: Set<Session>;
  taskSessions: Map<string, Set<Session>>;
  laneQueues: Map<string, string[]>;
  sessionBySocket: WeakMap<object, Session>;
  stopped: boolean;
  registrationToken: string;
  terminateGraceMs: number;
  idleTimeoutMs: number | null;
  heartbeatTimeoutMs: number;
  maxBufferedOutputBytes: number;
  idleTimer: Timer | null;
  stopServer: (() => Promise<void>) | null;
  handshakeTimeoutMs: number;
};

const DEFAULT_SERVER_VERSION = "0.1.0";
const DEFAULT_TERMINATE_GRACE_MS = 3_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFERED_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 1_000;

export async function startServer(options: StartServerOptions): Promise<CoordinatorServer> {
  await mkdir(options.runtimeDir, { recursive: true });

  const registrationPath = join(options.runtimeDir, "registration.json");
  const runtime: ServerRuntime = {
    taskManager: new TaskManager(),
    scheduler: new Scheduler(),
    taskStates: new Map(),
    sessions: new Set(),
    taskSessions: new Map(),
    laneQueues: new Map(),
    sessionBySocket: new WeakMap(),
    stopped: false,
    registrationToken: "",
    terminateGraceMs: options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS,
    idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
    maxBufferedOutputBytes: options.maxBufferedOutputBytes ?? DEFAULT_MAX_BUFFERED_OUTPUT_BYTES,
    idleTimer: null,
    stopServer: null,
    handshakeTimeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS,
  };

  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket: object) {
        const session: Session = {
          socket,
          buffer: "",
          authed: false,
          closed: false,
          subscriptions: new Map(),
          replays: new Map(),
          heartbeatTimer: null,
          handshakeTimer: null,
        };

        runtime.sessions.add(session);
        runtime.sessionBySocket.set(socket, session);
        refreshHandshakeTimer(runtime, session);
        refreshIdleTimer(runtime);
      },
      data(socket: object, chunk: string | Uint8Array) {
        const session = runtime.sessionBySocket.get(socket);
        if (!session || runtime.stopped) {
          return;
        }

        session.buffer += toUtf8(chunk);
        const decoded = decodeMessageChunk(session.buffer);
        session.buffer = decoded.remainder;

        for (const message of decoded.messages) {
          void handleMessage(runtime, session, message);
        }
      },
      close(socket: object) {
        const session = runtime.sessionBySocket.get(socket);
        if (!session) {
          return;
        }

        session.closed = true;
        clearHandshakeTimer(session);
        runtime.sessions.delete(session);
        void detachSession(runtime, session).finally(() => {
          refreshIdleTimer(runtime);
        });
      },
    },
  } as any);

  const registration: Registration = {
    pid: process.pid,
    port: server.port,
    token: randomUUID(),
    startedAt: Date.now(),
    version: options.serverVersion ?? DEFAULT_SERVER_VERSION,
    protocolVersion,
  };
  runtime.registrationToken = registration.token;

  const acquired = await acquireStartupLock(join(options.runtimeDir, "startup.lock"), {
    pid: process.pid,
    acquiredAt: registration.startedAt,
    staleAfterMs: 10_000,
    startupTimeoutMs: 3_000,
    coordinatorAvailable: () => true,
  });

  if (!acquired) {
    server.stop();
    throw new Error("failed to acquire startup lock");
  }

  try {
    await writeRegistration(registrationPath, registration);
  } catch (error) {
    server.stop();
    throw error;
  }

  const stop = async () => {
    if (runtime.stopped) {
      return;
    }

    runtime.stopped = true;
    clearIdleTimer(runtime);

    for (const taskState of runtime.taskStates.values()) {
      taskState.controller.abort();
    }

    for (const session of runtime.sessions) {
      session.closed = true;
      clearHandshakeTimer(session);
      clearHeartbeatTimer(session);
      session.socket.end?.();
      session.socket.terminate?.();
      session.socket.close?.();
    }

    await removeRegistration(registrationPath);
    server.stop();
    await rm(join(options.runtimeDir, "startup.lock"), { force: true });
  };

  runtime.stopServer = stop;
  refreshIdleTimer(runtime);

  return {
    port: server.port,
    registrationPath,
    registration,
    stop,
  };
}

async function handleMessage(runtime: ServerRuntime, session: Session, message: unknown): Promise<void> {
  if (!isRecord(message) || typeof message.type !== "string") {
    send(session, { type: "error", message: "invalid message" });
    return;
  }

  if (message.type === "hello") {
    await handleHello(runtime, session, message);
    return;
  }

  if (!session.authed) {
    send(session, { type: "error", message: "hello required before other messages" });
    return;
  }

  if (message.type === "heartbeat") {
    handleHeartbeat(runtime, session, message);
    return;
  }

  if (message.type === "cancel-subscription") {
    handleCancelSubscription(runtime, session, message);
    return;
  }

  if (message.type === "run") {
    await handleRun(runtime, session, message as unknown as RunMessage);
    return;
  }

  if (message.type === "cancel-task") {
    handleCancelTask(runtime, message);
    return;
  }

  if (message.type === "ps") {
    handlePs(runtime, session, message);
    return;
  }

  send(session, {
    type: "error",
    message: `unsupported message type: ${message.type}`,
  });
}

async function handleHello(runtime: ServerRuntime, session: Session, message: Record<string, unknown>): Promise<void> {
  if (typeof message.token !== "string" || typeof message.protocolVersion !== "number") {
    send(session, { type: "error", message: "invalid hello message" });
    session.socket.end();
    return;
  }

  if (message.token !== runtime.registrationToken) {
    send(session, { type: "error", message: "token mismatch" });
    session.socket.end();
    return;
  }

  if (message.protocolVersion !== protocolVersion) {
    send(session, { type: "error", message: "protocol mismatch" });
    session.socket.end();
    return;
  }

  session.authed = true;
  clearHandshakeTimer(session);
  refreshHeartbeatTimer(runtime, session);
  send(session, {
    type: "hello-ack",
    serverVersion: DEFAULT_SERVER_VERSION,
    protocolVersion,
  });
}

function handleHeartbeat(runtime: ServerRuntime, session: Session, message: Record<string, unknown>): void {
  if (typeof message.sentAt !== "number") {
    send(session, { type: "error", message: "invalid heartbeat message" });
    return;
  }

  refreshHeartbeatTimer(runtime, session);
  send(session, {
    type: "heartbeat-ack",
    sentAt: message.sentAt,
    serverTime: Date.now(),
  });
}

function handleCancelSubscription(runtime: ServerRuntime, session: Session, message: Record<string, unknown>): void {
  if (typeof message.taskId !== "string" || typeof message.subscriberId !== "string") {
    send(session, { type: "error", message: "invalid cancel-subscription message" });
    return;
  }

  void detachSubscriber(runtime, session, message.taskId, message.subscriberId, true);
  refreshIdleTimer(runtime);
}

async function handleRun(runtime: ServerRuntime, session: Session, message: RunMessage): Promise<void> {
  if (
    typeof message.requestId !== "string" ||
    typeof message.cwd !== "string" ||
    !Array.isArray(message.argv) ||
    message.argv.length === 0 ||
    message.argv.some((entry) => typeof entry !== "string")
  ) {
    send(session, { type: "error", requestId: asRequestId(message.requestId), message: "invalid run message" });
    return;
  }

  const cwd = await normalizeCwd(message.cwd);
  if (runtime.stopped || session.closed || !runtime.sessions.has(session) || !session.authed) {
    return;
  }

  const mergeMode: TaskMergeMode = message.mergeMode === "global" || message.mergeMode === "off" ? message.mergeMode : "by-cwd";
  const serialMode = message.serialMode === "by-cwd" ? "by-cwd" : "global";
  const result = runtime.taskManager.createOrAttach({
    cwd,
    argv: message.argv,
    mergeMode,
  });

  const snapshot = findTask(runtime, result.taskId);
  if (!snapshot) {
    send(session, { type: "error", requestId: message.requestId, message: "task unavailable" });
    return;
  }

  let taskState = runtime.taskStates.get(result.taskId);
  if (!taskState) {
    taskState = {
      taskId: result.taskId,
      serialMode,
      mergeMode,
      serialKey: serialMode === "global" ? "__global__" : cwd,
      controller: new AbortController(),
      buffer: new OutputBuffer(runtime.maxBufferedOutputBytes),
      terminalEventSent: false,
    };
    runtime.taskStates.set(result.taskId, taskState);

    const schedulerTask = toSchedulerTask(taskState);
    runtime.scheduler.enqueue(schedulerTask);
    enqueueLaneTask(runtime, taskState);
  }

  session.subscriptions.set(result.taskId, result.subscriberId);
  addTaskSession(runtime, result.taskId, session);

  send(session, {
    type: "accepted",
    requestId: message.requestId,
    taskId: result.taskId,
    subscriberId: result.subscriberId,
    merged: result.merged,
    executionCwd: snapshot.canonicalExecutionCwd,
    requestedCwd: cwd,
  });

  if (result.merged) {
    replayBufferedOutput(session, result.taskId, taskState.buffer);
  }

  if (snapshot.status === "queued") {
    const queuePosition = queuePositionFor(runtime, result.taskId);
    if (queuePosition !== undefined && queuePosition > 1) {
      sendTaskEvent(session, result.taskId, { type: "queued", position: queuePosition });
    }
  }

  drainScheduler(runtime, toSchedulerTask(taskState));
  refreshIdleTimer(runtime);
}

function handleCancelTask(runtime: ServerRuntime, message: Record<string, unknown>): void {
  if (typeof message.taskId !== "string") {
    return;
  }

  const taskId = message.taskId;
  const taskState = runtime.taskStates.get(taskId);
  const canceled = runtime.taskManager.cancelTask(taskId);
  if (!canceled) {
    return;
  }

  if (taskState) {
    taskState.controller.abort();
    emitCancelled(runtime, taskState);
    drainScheduler(runtime, toSchedulerTask(taskState));
  } else {
    broadcastTaskEvent(runtime, taskId, { type: "cancelled" });
  }

  refreshIdleTimer(runtime);
}

function handlePs(runtime: ServerRuntime, session: Session, message: Record<string, unknown>): void {
  if (typeof message.requestId !== "string") {
    send(session, { type: "error", message: "invalid ps message" });
    return;
  }

  const tasks = runtime.taskManager.listActiveTasks().map((task) => toPsTask(runtime, task));
  send(session, {
    type: "ps-result",
    requestId: message.requestId,
    tasks,
  });
}

async function detachSession(runtime: ServerRuntime, session: Session): Promise<void> {
  await detachSessionWithMode(runtime, session, false);
}

async function detachSessionWithMode(
  runtime: ServerRuntime,
  session: Session,
  notifyDetachingSession: boolean,
): Promise<void> {
  clearHeartbeatTimer(session);

  for (const [taskId, subscriberId] of session.subscriptions) {
    await detachSubscriber(runtime, session, taskId, subscriberId, notifyDetachingSession);
  }
}

async function detachSubscriber(
  runtime: ServerRuntime,
  session: Session,
  taskId: string,
  subscriberId: string,
  notifyDetachingSession: boolean,
): Promise<void> {
  const expectedSubscriberId = session.subscriptions.get(taskId);
  if (expectedSubscriberId !== subscriberId) {
    return;
  }

  const detached = runtime.taskManager.detachSubscriber(taskId, subscriberId);
  session.subscriptions.delete(taskId);
  session.replays.delete(taskId);

  if (!detached) {
    removeTaskSession(runtime, taskId, session);
    return;
  }

  const taskState = runtime.taskStates.get(taskId);
  const snapshot = findTask(runtime, taskId);

  if (snapshot?.status === "canceled") {
    if (taskState) {
      taskState.controller.abort();

      if (notifyDetachingSession && !taskState.terminalEventSent) {
        sendTaskEvent(session, taskId, { type: "cancelled" });
      }

      removeTaskSession(runtime, taskId, session);
      emitCancelled(runtime, taskState);
      drainScheduler(runtime, toSchedulerTask(taskState));
      return;
    }

    if (notifyDetachingSession) {
      sendTaskEvent(session, taskId, { type: "cancelled" });
    }
  }

  removeTaskSession(runtime, taskId, session);
}

async function evictSessionForHeartbeat(runtime: ServerRuntime, session: Session): Promise<void> {
  if (runtime.stopped || !runtime.sessions.has(session)) {
    return;
  }

  await detachSessionWithMode(runtime, session, true);
  runtime.sessions.delete(session);
  session.closed = true;
  session.socket.end?.();
  setTimeout(() => {
    session.socket.destroy?.();
  }, 25);
  refreshIdleTimer(runtime);
}

async function startTask(runtime: ServerRuntime, taskId: string): Promise<void> {
  if (runtime.stopped) {
    return;
  }

  const taskState = runtime.taskStates.get(taskId);
  if (!taskState) {
    return;
  }

  const snapshot = findTask(runtime, taskId);
  if (!snapshot) {
    finalizeTask(runtime, taskId);
    return;
  }

  if (!runtime.taskManager.markTaskRunning(taskId)) {
    finalizeTask(runtime, taskId);
    return;
  }

  broadcastTaskEvent(runtime, taskId, { type: "started" });

  try {
    const result = await runProcess({
      cwd: snapshot.canonicalExecutionCwd,
      argv: snapshot.argv,
      signal: taskState.controller.signal,
      graceMs: runtime.terminateGraceMs,
      onStdout(chunk) {
        appendOutput(runtime, taskId, "stdout", chunk);
      },
      onStderr(chunk) {
        appendOutput(runtime, taskId, "stderr", chunk);
      },
    });

    const latest = findTask(runtime, taskId);
    if (latest?.status === "canceled") {
      emitCancelled(runtime, taskState);
    } else {
      runtime.taskManager.markTaskFinished(taskId);
      broadcastTaskEvent(runtime, taskId, {
        type: "exited",
        code: result.code,
        signal: result.signal,
      });
    }
  } finally {
    finalizeTask(runtime, taskId);
    refreshIdleTimer(runtime);
  }
}

function appendOutput(runtime: ServerRuntime, taskId: string, stream: "stdout" | "stderr", data: string): void {
  const taskState = runtime.taskStates.get(taskId);
  if (!taskState) {
    return;
  }

  const chunk = taskState.buffer.append(stream, data);
  broadcastOutputChunk(runtime, taskId, chunk);
}

function replayBufferedOutput(session: Session, taskId: string, buffer: OutputBuffer): void {
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

function emitCancelled(runtime: ServerRuntime, taskState: TaskRuntimeState): void {
  if (taskState.terminalEventSent) {
    return;
  }

  taskState.terminalEventSent = true;
  broadcastTaskEvent(runtime, taskState.taskId, { type: "cancelled" });
}

function finalizeTask(runtime: ServerRuntime, taskId: string): void {
  const taskState = runtime.taskStates.get(taskId);
  if (!taskState) {
    return;
  }

  runtime.scheduler.markFinished(taskId);
  dequeueLaneTask(runtime, taskState);
  runtime.taskStates.delete(taskId);
  if (!runtime.stopped) {
    drainScheduler(runtime, toSchedulerTask(taskState));
  }
}

function drainScheduler(runtime: ServerRuntime, taskLike: Pick<SchedulerTask, "serialMode" | "mergeMode" | "serialKey">): void {
  if (runtime.stopped) {
    return;
  }

  while (true) {
    const next = runtime.scheduler.nextRunnableFor(taskLike);
    if (!next) {
      return;
    }

    const snapshot = findTask(runtime, next.taskId);
    if (snapshot?.status === "canceled") {
      finalizeTask(runtime, next.taskId);
      continue;
    }

    if (!runtime.scheduler.markRunning(next.taskId)) {
      return;
    }

    void startTask(runtime, next.taskId);
    return;
  }
}

function refreshIdleTimer(runtime: ServerRuntime): void {
  if (runtime.idleTimeoutMs === null) {
    return;
  }

  const authedSessionCount = Array.from(runtime.sessions).filter((session) => session.authed).length;
  const idle = authedSessionCount === 0 && runtime.taskManager.listActiveTasks().length === 0;
  if (!idle) {
    clearIdleTimer(runtime);
    return;
  }

  if (runtime.idleTimer !== null) {
    return;
  }

  runtime.idleTimer = setTimeout(() => {
    runtime.idleTimer = null;
    void runtime.stopServer?.();
  }, runtime.idleTimeoutMs);
}

function refreshHeartbeatTimer(runtime: ServerRuntime, session: Session): void {
  clearHeartbeatTimer(session);
  session.heartbeatTimer = setTimeout(() => {
    void evictSessionForHeartbeat(runtime, session);
  }, runtime.heartbeatTimeoutMs);
}

function refreshHandshakeTimer(runtime: ServerRuntime, session: Session): void {
  clearHandshakeTimer(session);
  session.handshakeTimer = setTimeout(() => {
    if (session.authed || session.closed || runtime.stopped || !runtime.sessions.has(session)) {
      return;
    }

    runtime.sessions.delete(session);
    session.closed = true;
    session.socket.end?.();
    session.socket.terminate?.();
    session.socket.close?.();
    refreshIdleTimer(runtime);
  }, runtime.handshakeTimeoutMs);
}

function clearHeartbeatTimer(session: Session): void {
  if (session.heartbeatTimer === null) {
    return;
  }

  clearTimeout(session.heartbeatTimer);
  session.heartbeatTimer = null;
}

function clearHandshakeTimer(session: Session): void {
  if (session.handshakeTimer === null) {
    return;
  }

  clearTimeout(session.handshakeTimer);
  session.handshakeTimer = null;
}

function clearIdleTimer(runtime: ServerRuntime): void {
  if (runtime.idleTimer === null) {
    return;
  }

  clearTimeout(runtime.idleTimer);
  runtime.idleTimer = null;
}

function findTask(runtime: ServerRuntime, taskId: string): TaskSnapshot | undefined {
  return runtime.taskManager.listTasks().find((task) => task.taskId === taskId);
}

function toSchedulerTask(taskState: TaskRuntimeState): SchedulerTask {
  return {
    taskId: taskState.taskId,
    serialMode: taskState.serialMode,
    mergeMode: taskState.mergeMode,
    serialKey: taskState.serialKey,
  };
}

function toPsTask(runtime: ServerRuntime, task: TaskSnapshot): PsTask {
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

function queuePositionFor(runtime: ServerRuntime, taskId: string): number | undefined {
  for (const taskIds of runtime.laneQueues.values()) {
    const index = taskIds.indexOf(taskId);
    if (index !== -1) {
      return index + 1;
    }
  }

  return undefined;
}

function enqueueLaneTask(runtime: ServerRuntime, taskState: TaskRuntimeState): void {
  const laneKey = resolveLaneKey(taskState);
  const taskIds = runtime.laneQueues.get(laneKey) ?? [];
  taskIds.push(taskState.taskId);
  runtime.laneQueues.set(laneKey, taskIds);
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

function resolveLaneKey(taskState: Pick<TaskRuntimeState, "serialMode" | "mergeMode" | "serialKey">): string {
  if (taskState.mergeMode === "global" || taskState.serialMode === "global") {
    return "global";
  }

  return taskState.serialKey;
}

function addTaskSession(runtime: ServerRuntime, taskId: string, session: Session): void {
  const sessions = runtime.taskSessions.get(taskId) ?? new Set<Session>();
  sessions.add(session);
  runtime.taskSessions.set(taskId, sessions);
}

function removeTaskSession(runtime: ServerRuntime, taskId: string, session: Session): void {
  const sessions = runtime.taskSessions.get(taskId);
  if (!sessions) {
    return;
  }

  sessions.delete(session);
  if (sessions.size === 0) {
    runtime.taskSessions.delete(taskId);
  }
}

function broadcastTaskEvent(runtime: ServerRuntime, taskId: string, event: TaskEvent): void {
  const sessions = runtime.taskSessions.get(taskId);
  if (!sessions) {
    return;
  }

  for (const session of sessions) {
    sendTaskEvent(session, taskId, event);
  }
}

function sendTaskEvent(session: Session, taskId: string, event: TaskEvent): void {
  send(session, {
    type: "task-event",
    taskId,
    event,
  });
}

function send(session: Session, message: ServerToClient): void {
  session.socket.write(encodeMessage(message));
}

function toUtf8(chunk: string | Uint8Array): string {
  if (typeof chunk === "string") {
    return chunk;
  }

  return new TextDecoder().decode(chunk);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asRequestId(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

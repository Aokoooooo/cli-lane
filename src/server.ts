import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "./process-runner";
import { decodeMessageChunk, encodeMessage, protocolVersion, type ServerToClient } from "./protocol";
import { normalizeCwd } from "./path-utils";
import { acquireStartupLock, removeRegistration, type Registration, writeRegistration } from "./registry";
import { Scheduler } from "./scheduler";
import { TaskManager, type TaskMergeMode } from "./task-manager";

export type StartServerOptions = {
  runtimeDir: string;
  serverVersion?: string;
  terminateGraceMs?: number;
  idleTimeoutMs?: number;
};

export type CoordinatorServer = {
  port: number;
  registrationPath: string;
  registration: Registration;
  stop: () => Promise<void>;
};

type Session = {
  socket: any;
  buffer: string;
  authed: boolean;
  subscriptions: Map<string, string>;
};

type RunState = {
  taskId: string;
  serialMode: "global" | "by-cwd";
  mergeMode: TaskMergeMode;
  serialKey: string;
  controller: AbortController;
  terminalEventSent: boolean;
};

type ServerRuntime = {
  taskManager: TaskManager;
  scheduler: Scheduler;
  runs: Map<string, RunState>;
  sessions: Set<Session>;
  taskSessions: Map<string, Set<Session>>;
  sessionBySocket: WeakMap<object, Session>;
  stopped: boolean;
  registrationToken: string;
  terminateGraceMs: number;
};

const DEFAULT_SERVER_VERSION = "0.1.0";

export async function startServer(options: StartServerOptions): Promise<CoordinatorServer> {
  await mkdir(options.runtimeDir, { recursive: true });

  const registrationPath = join(options.runtimeDir, "registration.json");
  const terminateGraceMs = options.terminateGraceMs ?? 3_000;
  const runtime: ServerRuntime = {
    taskManager: new TaskManager(),
    scheduler: new Scheduler(),
    runs: new Map(),
    sessions: new Set(),
    taskSessions: new Map(),
    sessionBySocket: new WeakMap(),
    stopped: false,
    registrationToken: "",
    terminateGraceMs,
  };

  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        const session: Session = {
          socket,
          buffer: "",
          authed: false,
          subscriptions: new Map(),
        };

        runtime.sessions.add(session);
        runtime.sessionBySocket.set(socket, session);
      },
      data(socket, chunk) {
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
      close(socket) {
        const session = runtime.sessionBySocket.get(socket);
        if (!session) {
          return;
        }

        runtime.sessions.delete(session);
        void detachSession(runtime, session);
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

  return {
    port: server.port,
    registrationPath,
    registration,
    stop: async () => {
      if (runtime.stopped) {
        return;
      }

      runtime.stopped = true;

      for (const runState of runtime.runs.values()) {
        runState.controller.abort();
      }

      for (const session of runtime.sessions) {
        session.socket.end();
      }

      await removeRegistration(registrationPath);
      server.stop();
      await rm(join(options.runtimeDir, "startup.lock"), { force: true });
    },
  };
}

async function handleMessage(runtime: ServerRuntime, session: Session, message: unknown): Promise<void> {
  if (!isRecord(message) || typeof message.type !== "string") {
    send(session, {
      type: "error",
      message: "invalid message",
    });
    return;
  }

  if (message.type === "hello") {
    await handleHello(session, message, runtime.registrationToken);
    return;
  }

  if (!session.authed) {
    send(session, {
      type: "error",
      message: "hello required before other messages",
    });
    return;
  }

  if (message.type === "heartbeat") {
    handleHeartbeat(session, message);
    return;
  }

  if (message.type === "run") {
    await handleRun(runtime, session, message);
    return;
  }

  if (message.type === "cancel-task") {
    await handleCancelTask(runtime, session, message);
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

async function handleHello(session: Session, message: Record<string, unknown>, expectedToken: string): Promise<void> {
  if (typeof message.token !== "string" || typeof message.protocolVersion !== "number") {
    send(session, { type: "error", message: "invalid hello message" });
    session.socket.end();
    return;
  }

  if (message.token !== expectedToken) {
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
  send(session, {
    type: "hello-ack",
    serverVersion: DEFAULT_SERVER_VERSION,
    protocolVersion,
  });
}

function handleHeartbeat(session: Session, message: Record<string, unknown>): void {
  if (typeof message.sentAt !== "number") {
    send(session, { type: "error", message: "invalid heartbeat message" });
    return;
  }

  send(session, {
    type: "heartbeat-ack",
    sentAt: message.sentAt,
    serverTime: Date.now(),
  });
}

async function handleRun(runtime: ServerRuntime, session: Session, message: Record<string, unknown>): Promise<void> {
  if (typeof message.requestId !== "string" || typeof message.cwd !== "string" || !Array.isArray(message.argv)) {
    send(session, { type: "error", requestId: asRequestId(message.requestId), message: "invalid run message" });
    return;
  }

  const argv = message.argv.filter((entry): entry is string => typeof entry === "string");
  if (argv.length !== message.argv.length || argv.length === 0) {
    send(session, { type: "error", requestId: message.requestId, message: "invalid argv" });
    return;
  }

  const serialMode = message.serialMode === "by-cwd" ? "by-cwd" : "global";
  const mergeMode: TaskMergeMode = message.mergeMode === "global" || message.mergeMode === "off" ? message.mergeMode : "by-cwd";
  const cwd = await normalizeCwd(message.cwd);

  const result = runtime.taskManager.createOrAttach({
    cwd,
    argv,
    mergeMode,
  });

  const snapshot = runtime.taskManager.listTasks().find((task) => task.taskId === result.taskId);
  if (!snapshot) {
    send(session, { type: "error", requestId: message.requestId, message: "task unavailable" });
    return;
  }

  session.subscriptions.set(result.taskId, result.subscriberId);
  addTaskSession(runtime, result.taskId, session);

  send(session, {
    type: "accepted",
    requestId: message.requestId,
    taskId: result.taskId,
    subscriberId: result.subscriberId,
    merged: result.merged,
  });

  const serialKey = serialMode === "global" ? "__global__" : cwd;
  const taskLike = {
    taskId: result.taskId,
    serialMode,
    mergeMode,
    serialKey,
  } as const;

  runtime.runs.set(result.taskId, {
    taskId: result.taskId,
    serialMode,
    mergeMode,
    serialKey,
    controller: new AbortController(),
    terminalEventSent: false,
  });

  if (snapshot.status === "queued" && runtime.scheduler.nextRunnableFor(taskLike)?.taskId !== result.taskId) {
    maybeSendQueuedPrompt(runtime, result.taskId, snapshot);
  }

  drainScheduler(runtime, taskLike);
}

async function handleCancelTask(runtime: ServerRuntime, session: Session, message: Record<string, unknown>): Promise<void> {
  if (typeof message.taskId !== "string") {
    send(session, { type: "error", message: "invalid cancel-task message" });
    return;
  }

  const runState = runtime.runs.get(message.taskId);
  const canceled = runtime.taskManager.cancelTask(message.taskId);

  if (!canceled) {
    send(session, { type: "error", message: "task not found or not cancellable" });
    return;
  }

  if (runState) {
    runState.controller.abort();
    if (!runState.terminalEventSent) {
      broadcastTaskEvent(runtime, message.taskId, "cancelled");
      runState.terminalEventSent = true;
    }
  } else {
    broadcastTaskEvent(runtime, message.taskId, "cancelled");
  }

  if (runState) {
    drainScheduler(runtime, runState);
  }
}

function handlePs(runtime: ServerRuntime, session: Session, message: Record<string, unknown>): void {
  if (typeof message.requestId !== "string") {
    send(session, { type: "error", message: "invalid ps message" });
    return;
  }

  send(session, {
    type: "ps-result",
    requestId: message.requestId,
    tasks: runtime.taskManager.listActiveTasks().map((task) => ({ taskId: task.taskId })),
  });
}

async function detachSession(runtime: ServerRuntime, session: Session): Promise<void> {
  for (const [taskId, subscriberId] of session.subscriptions) {
    session.subscriptions.delete(taskId);
    removeTaskSession(runtime, taskId, session);

    const runState = runtime.runs.get(taskId);
    const detached = runtime.taskManager.detachSubscriber(taskId, subscriberId);
    if (!detached) {
      continue;
    }

    const snapshot = runtime.taskManager.listTasks().find((task) => task.taskId === taskId);
    if (snapshot?.status === "canceled") {
      runState?.controller.abort();
      if (!runState) {
        broadcastTaskEvent(runtime, taskId, "cancelled");
      }
    }
  }
}

async function startTask(runtime: ServerRuntime, taskId: string): Promise<void> {
  const runState = runtime.runs.get(taskId);
  if (!runState) {
    return;
  }

  const snapshot = runtime.taskManager.listTasks().find((task) => task.taskId === taskId);
  if (!snapshot) {
    runtime.scheduler.markFinished(taskId);
    runtime.runs.delete(taskId);
    return;
  }

  if (!runtime.taskManager.markTaskRunning(taskId)) {
    runtime.scheduler.markFinished(taskId);
    runtime.runs.delete(taskId);
    return;
  }

  broadcastTaskEvent(runtime, taskId, "started");

  try {
    const result = await runProcess({
      cwd: snapshot.canonicalExecutionCwd,
      argv: snapshot.argv,
      signal: runState.controller.signal,
      graceMs: runtime.terminateGraceMs,
    });

    const latest = runtime.taskManager.listTasks().find((task) => task.taskId === taskId);
    if (latest?.status === "canceled") {
      if (!runState.terminalEventSent) {
        broadcastTaskEvent(runtime, taskId, "cancelled");
        runState.terminalEventSent = true;
      }
    } else {
      runtime.taskManager.markTaskFinished(taskId);
      broadcastTaskEvent(runtime, taskId, "exited");
    }

    runtime.scheduler.markFinished(taskId);
  } finally {
    runtime.runs.delete(taskId);
    drainScheduler(runtime, runState);
  }
}

function drainScheduler(runtime: ServerRuntime, taskLike: { serialMode: "global" | "by-cwd"; mergeMode: TaskMergeMode; serialKey: string }): void {
  while (true) {
    const next = runtime.scheduler.nextRunnableFor(taskLike);
    if (!next) {
      return;
    }

    const snapshot = runtime.taskManager.listTasks().find((task) => task.taskId === next.taskId);
    if (snapshot?.status === "canceled") {
      if (runtime.scheduler.markRunning(next.taskId)) {
        runtime.scheduler.markFinished(next.taskId);
      }
      continue;
    }

    if (!runtime.scheduler.markRunning(next.taskId)) {
      return;
    }

    void startTask(runtime, next.taskId);
    return;
  }
}

function maybeSendQueuedPrompt(runtime: ServerRuntime, taskId: string, snapshot: { taskId: string }): void {
  const sessions = runtime.taskSessions.get(taskId);
  if (!sessions || sessions.size === 0) {
    return;
  }

  for (const session of sessions) {
    send(session, {
      type: "task-event",
      taskId: snapshot.taskId,
      event: "queued",
    });
  }
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

function broadcastTaskEvent(runtime: ServerRuntime, taskId: string, event: string): void {
  const sessions = runtime.taskSessions.get(taskId);
  if (!sessions) {
    return;
  }

  for (const session of sessions) {
    send(session, {
      type: "task-event",
      taskId,
      event,
    });
  }
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

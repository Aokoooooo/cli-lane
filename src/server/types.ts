import type { OutputBuffer } from "../output-buffer";
import type { ServerToClient } from "../protocol";
import type { Scheduler } from "../scheduler";
import type { TaskManager } from "../task-manager";
import type { TaskMergeModeValue, TaskSerialMode } from "../task-routing";

export type ReplayState = {
  lastSeq: number;
  pending: ServerToClient[];
};

export type Session = {
  socket: any;
  buffer: string;
  authed: boolean;
  closed: boolean;
  subscriptions: Map<string, string>;
  replays: Map<string, ReplayState>;
  heartbeatTimer: Timer | null;
  handshakeTimer: Timer | null;
};

export type TaskRuntimeState = {
  taskId: string;
  serialMode: TaskSerialMode;
  mergeMode: TaskMergeModeValue;
  serialKey: string;
  controller: AbortController;
  buffer: OutputBuffer;
  terminalEventSent: boolean;
};

export type ServerRuntime = {
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

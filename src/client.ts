import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readRegistration, type Registration } from "./registry";
import {
  decodeMessageChunk,
  encodeMessage,
  protocolVersion,
  type AcceptedMessage,
  type ClientToServer,
  type PsResultMessage,
  type RunMessage,
  type ServerToClient,
  type SubscriptionDetachedMessage,
} from "./protocol";
import { startServer, type CoordinatorServer, type StartServerOptions } from "./server";

export type ClientOptions = {
  runtimeDir: string;
  clientVersion?: string;
  heartbeatIntervalMs?: number;
  bootstrapIfMissing?: boolean;
  onMessage?: (message: ServerToClient) => void;
  startServer?: (options: StartServerOptions) => Promise<CoordinatorServer>;
};

export type Client = {
  run(request: Omit<RunMessage, "type" | "requestId">): Promise<AcceptedMessage>;
  ps(): Promise<PsResultMessage>;
  cancelTask(taskId: string): Promise<void>;
  cancelSubscription(taskId: string, subscriberId: string): Promise<SubscriptionDetachedMessage>;
  close(): Promise<void>;
};

type Waiter<T> = {
  predicate: (message: ServerToClient) => message is T;
  resolve: (message: T) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type ConnectionState = {
  socket: any;
  buffer: string;
  history: ServerToClient[];
  waiters: Array<Waiter<any>>;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  closed: boolean;
  bootstrappedServer: CoordinatorServer | null;
  registration: Registration;
  onMessage?: (message: ServerToClient) => void;
  closePromise: Promise<void>;
  resolveClose: (() => void) | null;
};

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_BOOTSTRAP_IF_MISSING = true;

export async function createClient(options: ClientOptions): Promise<Client> {
  const runtimeDir = options.runtimeDir;
  const clientVersion = options.clientVersion ?? "0.1.0";
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const bootstrapIfMissing = options.bootstrapIfMissing ?? DEFAULT_BOOTSTRAP_IF_MISSING;
  const startCoordinator = options.startServer ?? startServer;

  const state = await connectOrBootstrap({
    runtimeDir,
    bootstrapIfMissing,
    startCoordinator,
    clientVersion,
    onMessage: options.onMessage,
  });

  startHeartbeat(state, heartbeatIntervalMs);

  return {
    run(request) {
      return sendRequest<AcceptedMessage>(state, {
        type: "run",
        requestId: randomUUID(),
        cwd: request.cwd,
        argv: [...request.argv],
        serialMode: request.serialMode ?? "global",
        mergeMode: request.mergeMode ?? "by-cwd",
      });
    },
    ps() {
      return sendRequest<PsResultMessage>(state, {
        type: "ps",
        requestId: randomUUID(),
      });
    },
    async cancelTask(taskId: string) {
      sendMessage(state, {
        type: "cancel-task",
        taskId,
      });
    },
    cancelSubscription(taskId: string, subscriberId: string) {
      sendMessage(state, {
        type: "cancel-subscription",
        taskId,
        subscriberId,
      });

      return waitForMessage<SubscriptionDetachedMessage>(
        state,
        (message): message is SubscriptionDetachedMessage =>
          message.type === "subscription-detached" &&
          message.taskId === taskId &&
          message.subscriberId === subscriberId,
      );
    },
    close() {
      return closeClient(state);
    },
  };
}

async function connectOrBootstrap(options: {
  runtimeDir: string;
  bootstrapIfMissing: boolean;
  startCoordinator: (options: StartServerOptions) => Promise<CoordinatorServer>;
  clientVersion: string;
  onMessage?: (message: ServerToClient) => void;
}): Promise<ConnectionState> {
  const registrationPath = join(options.runtimeDir, "registration.json");
  const existing = await readRegistration(registrationPath);

  if (existing) {
    try {
      return await connectToRegistration(existing, null, options.clientVersion, options.onMessage);
    } catch (error) {
      if (!options.bootstrapIfMissing) {
        throw error;
      }
    }
  } else if (!options.bootstrapIfMissing) {
    throw new Error("coordinator registration not found");
  }

  const bootstrappedServer = await options.startCoordinator({ runtimeDir: options.runtimeDir });
  return await connectToRegistration(
    bootstrappedServer.registration,
    bootstrappedServer,
    options.clientVersion,
    options.onMessage,
  );
}

async function connectToRegistration(
  registration: Registration,
  bootstrappedServer: CoordinatorServer | null,
  clientVersion: string,
  onMessage?: (message: ServerToClient) => void,
): Promise<ConnectionState> {
  const state = await openSocket(registration.port, bootstrappedServer, registration);
  state.onMessage = onMessage;

  sendMessage(state, {
    type: "hello",
    token: registration.token,
    protocolVersion,
    clientVersion,
  });

  const hello = await waitForMessage(
    state,
    (message): message is Extract<ServerToClient, { type: "hello-ack" }> => message.type === "hello-ack",
  );

  if (hello.protocolVersion !== protocolVersion) {
    throw new Error("protocol mismatch");
  }

  return state;
}

async function openSocket(
  port: number,
  bootstrappedServer: CoordinatorServer | null,
  registration: Registration,
): Promise<ConnectionState> {
  let resolveClose: (() => void) | null = null;
  const closePromise = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });

  const state: ConnectionState = {
    socket: null,
    buffer: "",
    history: [],
    waiters: [],
    heartbeatTimer: null,
    closed: false,
    bootstrappedServer,
    registration,
    onMessage: undefined,
    closePromise,
    resolveClose,
  };

  await new Promise<void>((resolve, reject) => {
    const socket = (Bun as any).connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(clientSocket: any) {
          state.socket = clientSocket;
          resolve();
        },
        data(_clientSocket: any, chunk: string | Uint8Array) {
          if (state.closed) {
            return;
          }

          state.buffer += toUtf8(chunk);
          const decoded = decodeMessageChunk(state.buffer);
          state.buffer = decoded.remainder;

          for (const message of decoded.messages as ServerToClient[]) {
            handleInboundMessage(state, message);
          }
        },
        close() {
          state.closed = true;
          clearHeartbeatTimer(state);
          rejectWaiters(state, new Error("client disconnected"));
          state.resolveClose?.();
        },
        error(_clientSocket: any, error: Error) {
          reject(error);
        },
      },
    });

    if (socket && !state.socket) {
      state.socket = socket;
    }
  });

  return state;
}

function startHeartbeat(state: ConnectionState, heartbeatIntervalMs: number): void {
  clearHeartbeatTimer(state);
  state.heartbeatTimer = setInterval(() => {
    if (state.closed) {
      clearHeartbeatTimer(state);
      return;
    }

    sendMessage(state, {
      type: "heartbeat",
      sentAt: Date.now(),
    });
  }, heartbeatIntervalMs);
}

async function sendRequest<T extends ServerToClient>(
  state: ConnectionState,
  message: ClientToServer,
): Promise<T> {
  sendMessage(state, message);

  if (message.type === "run") {
    return await waitForMessage(
      state,
      (candidate): candidate is T =>
        candidate.type === "accepted" &&
        candidate.requestId === message.requestId,
    );
  }

  if (message.type === "ps") {
    return await waitForMessage(
      state,
      (candidate): candidate is T =>
        candidate.type === "ps-result" &&
        candidate.requestId === message.requestId,
    );
  }

  throw new Error("unsupported request type");
}

function sendMessage(state: ConnectionState, message: ClientToServer): void {
  if (state.closed || !state.socket) {
    throw new Error("client is closed");
  }

  state.socket.write(encodeMessage(message));
}

function handleInboundMessage(state: ConnectionState, message: ServerToClient): void {
  state.history.push(message);
  state.onMessage?.(message);
  for (const waiter of [...state.waiters]) {
    if (!waiter.predicate(message)) {
      continue;
    }

    clearTimeout(waiter.timeout);
    state.waiters.splice(state.waiters.indexOf(waiter), 1);
    waiter.resolve(message);
  }
}

async function waitForMessage<T extends ServerToClient>(
  state: ConnectionState,
  predicate: (message: ServerToClient) => message is T,
  timeoutMs = 2_000,
): Promise<T> {
  if (state.closed) {
    throw new Error("client is closed");
  }

  for (const message of state.history) {
    if (predicate(message)) {
      return message;
    }
  }

  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const index = state.waiters.findIndex((entry) => entry.timeout === timeout);
      if (index !== -1) {
        state.waiters.splice(index, 1);
      }
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    state.waiters.push({
      predicate,
      resolve,
      reject,
      timeout,
    });
  });
}

async function closeClient(state: ConnectionState): Promise<void> {
  if (state.closed) {
    await state.closePromise;
    return;
  }

  state.closed = true;
  clearHeartbeatTimer(state);
  rejectWaiters(state, new Error("client is closed"));

  const socket = state.socket;
  socket?.end?.();
  socket?.close?.();
  socket?.destroy?.();

  await Promise.race([
    state.closePromise,
    new Promise<void>((resolve) => setTimeout(resolve, 50)),
  ]);

  if (state.bootstrappedServer) {
    await state.bootstrappedServer.stop();
  }
}

function clearHeartbeatTimer(state: ConnectionState): void {
  if (state.heartbeatTimer === null) {
    return;
  }

  clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = null;
}

function rejectWaiters(state: ConnectionState, error: Error): void {
  for (const waiter of state.waiters.splice(0)) {
    clearTimeout(waiter.timeout);
    waiter.reject(error);
  }
}

function toUtf8(chunk: string | Uint8Array): string {
  if (typeof chunk === "string") {
    return chunk;
  }

  return new TextDecoder().decode(chunk);
}

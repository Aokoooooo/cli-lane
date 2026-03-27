export const protocolVersion = 1;
export type ProtocolVersion = typeof protocolVersion;

export type TaskEvent =
  | {
      type: "queued";
      position: number;
    }
  | {
      type: "started";
    }
  | {
      type: "stdout" | "stderr";
      data: string;
      seq: number;
      ts: number;
      bytes: number;
      replay: boolean;
    }
  | {
      type: "cancelled";
    }
  | {
      type: "exited";
      code: number | null;
      signal: string | null;
    };

export type PsTask = {
  taskId: string;
  status: "queued" | "running";
  cwd: string;
  argv: string[];
  subscriberCount: number;
  merged: boolean;
  queuePosition?: number;
};

export type HelloMessage = {
  type: "hello";
  token: string;
  protocolVersion: ProtocolVersion;
  clientVersion: string;
};

export type HeartbeatMessage = {
  type: "heartbeat";
  sentAt: number;
};

export type RunMessage = {
  type: "run";
  requestId: string;
  cwd: string;
  argv: string[];
  serialMode: "global" | "by-cwd";
  mergeMode: "by-cwd" | "global" | "off";
};

export type CancelSubscriptionMessage = {
  type: "cancel-subscription";
  taskId: string;
  subscriberId: string;
};

export type CancelTaskMessage = {
  type: "cancel-task";
  taskId: string;
};

export type PsMessage = {
  type: "ps";
  requestId: string;
};

export type AcceptedMessage = {
  type: "accepted";
  requestId: string;
  taskId: string;
  subscriberId: string;
  merged: boolean;
  executionCwd: string;
  requestedCwd: string;
};

export type TaskEventMessage = {
  type: "task-event";
  taskId: string;
  event: TaskEvent;
};

export type SubscriptionDetachedMessage = {
  type: "subscription-detached";
  taskId: string;
  subscriberId: string;
  remainingSubscribers: number;
  taskStillRunning: boolean;
};

export type PsResultMessage = {
  type: "ps-result";
  requestId: string;
  tasks: PsTask[];
};

export type ErrorMessage = {
  type: "error";
  message: string;
  requestId?: string;
};

export type HelloAckMessage = {
  type: "hello-ack";
  serverVersion: string;
  protocolVersion: ProtocolVersion;
};

export type HeartbeatAckMessage = {
  type: "heartbeat-ack";
  sentAt: number;
  serverTime: number;
};

export type ClientToServer =
  | HelloMessage
  | HeartbeatMessage
  | RunMessage
  | CancelSubscriptionMessage
  | CancelTaskMessage
  | PsMessage;

export type ServerToClient =
  | HelloAckMessage
  | HeartbeatAckMessage
  | AcceptedMessage
  | TaskEventMessage
  | SubscriptionDetachedMessage
  | PsResultMessage
  | ErrorMessage;

export type ProtocolMessage = ClientToServer | ServerToClient;

export function encodeMessage(message: ProtocolMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function decodeMessageChunk(buffer: string): {
  messages: unknown[];
  remainder: string;
} {
  const lines = buffer.split(/\r?\n/);
  const hasTrailingNewline = /\r?\n$/.test(buffer);
  const remainder = hasTrailingNewline ? "" : lines.pop() ?? "";
  const messages: unknown[] = [];

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    try {
      messages.push(JSON.parse(line));
    } catch {
      // Malformed complete lines are ignored in this minimal codec.
      continue;
    }
  }

  return { messages, remainder };
}

export function decodeMessages(buffer: string): unknown[] {
  return decodeMessageChunk(buffer).messages;
}

export const protocolVersion = 1;

export type HelloMessage = {
  type: "hello";
  token: string;
  protocolVersion: number;
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
  serialMode: boolean;
  mergeMode: boolean;
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
};

export type TaskEventMessage = {
  type: "task-event";
  taskId: string;
  event: string;
};

export type PsResultMessage = {
  type: "ps-result";
  requestId: string;
  tasks: unknown[];
};

export type ErrorMessage = {
  type: "error";
  message: string;
  requestId?: string;
};

export type HelloAckMessage = {
  type: "hello-ack";
  serverVersion: string;
  protocolVersion: number;
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
  | PsResultMessage
  | ErrorMessage;

export function encodeMessage(message: { type: string }): string {
  return `${JSON.stringify(message)}\n`;
}

export function decodeMessages(buffer: string): unknown[] {
  const messages: unknown[] = [];

  for (const line of buffer.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    try {
      messages.push(JSON.parse(line));
    } catch {
      continue;
    }
  }

  return messages;
}

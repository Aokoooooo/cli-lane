export const protocolVersion = "1";

export type HelloMessage = {
  type: "hello";
  protocolVersion?: string;
  clientVersion?: string;
};

export type HeartbeatMessage = {
  type: "heartbeat";
  sentAt: number;
};

export type AcceptedMessage = {
  type: "accepted";
  taskId: string;
};

export type TaskEventMessage = {
  type: "task-event";
  taskId: string;
  event: string;
};

export type PsResultMessage = {
  type: "ps-result";
  taskId: string;
  output?: string;
  exitCode?: number;
};

export type ErrorMessage = {
  type: "error";
  message: string;
};

export type ClientToServer = HelloMessage | HeartbeatMessage | TaskEventMessage;

export type ServerToClient =
  | HelloMessage
  | HeartbeatMessage
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

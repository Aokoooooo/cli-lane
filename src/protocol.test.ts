import { expect, test } from "bun:test";
import { decodeMessageChunk, decodeMessages, encodeMessage } from "./protocol";

test("encodes and decodes hello messages", () => {
  const raw = encodeMessage({
    type: "hello",
    token: "token-1",
    protocolVersion: 1,
    clientVersion: "1.0.0",
  });
  const messages = decodeMessages(raw);

  expect(messages).toEqual([
    {
      type: "hello",
      token: "token-1",
      protocolVersion: 1,
      clientVersion: "1.0.0",
    },
  ]);
});

test("encodes and decodes heartbeat messages", () => {
  const raw = encodeMessage({ type: "heartbeat", sentAt: 1 });
  const messages = decodeMessages(raw);

  expect(messages).toEqual([{ type: "heartbeat", sentAt: 1 }]);
});

test("encodes and decodes task-event messages", () => {
  const raw = encodeMessage({ type: "task-event", taskId: "task-1", event: "started" });
  const messages = decodeMessages(raw);

  expect(messages).toEqual([{ type: "task-event", taskId: "task-1", event: "started" }]);
});

test("encodes and decodes run messages with mode strings", () => {
  const raw = encodeMessage({
    type: "run",
    requestId: "req-1",
    cwd: "/workspace",
    argv: ["bun", "run"],
    serialMode: "by-cwd",
    mergeMode: "off",
  });
  const messages = decodeMessages(raw);

  expect(messages).toEqual([
    {
      type: "run",
      requestId: "req-1",
      cwd: "/workspace",
      argv: ["bun", "run"],
      serialMode: "by-cwd",
      mergeMode: "off",
    },
  ]);
});

test("encodes and decodes accepted messages", () => {
  const raw = encodeMessage({
    type: "accepted",
    requestId: "req-1",
    taskId: "task-1",
    subscriberId: "sub-1",
    merged: false,
  });
  const messages = decodeMessages(raw);

  expect(messages).toEqual([
    {
      type: "accepted",
      requestId: "req-1",
      taskId: "task-1",
      subscriberId: "sub-1",
      merged: false,
    },
  ]);
});

test("encodes and decodes ps-result messages", () => {
  const raw = encodeMessage({
    type: "ps-result",
    requestId: "req-1",
    tasks: [{ taskId: "task-1" }],
  });
  const messages = decodeMessages(raw);

  expect(messages).toEqual([
    {
      type: "ps-result",
      requestId: "req-1",
      tasks: [{ taskId: "task-1" }],
    },
  ]);
});

test("encodes and decodes error messages", () => {
  const raw = encodeMessage({
    type: "error",
    message: "failed",
    requestId: "req-1",
  });
  const messages = decodeMessages(raw);

  expect(messages).toEqual([
    {
      type: "error",
      message: "failed",
      requestId: "req-1",
    },
  ]);
});

test("decodes multiple ndjson messages in one buffer", () => {
  const raw = [
    encodeMessage({ type: "heartbeat", sentAt: 1 }).trimEnd(),
    encodeMessage({ type: "task-event", taskId: "task-1", event: "started" }).trimEnd(),
  ].join("\n") + "\n";

  expect(decodeMessages(raw)).toEqual([
    { type: "heartbeat", sentAt: 1 },
    { type: "task-event", taskId: "task-1", event: "started" },
  ]);
});

test("preserves trailing partial line in chunk decoder", () => {
  const partial = `{"type":"task-event","taskId":"task-1"`;
  const raw = `${encodeMessage({ type: "heartbeat", sentAt: 1 })}${partial}`;

  expect(decodeMessageChunk(raw)).toEqual({
    messages: [{ type: "heartbeat", sentAt: 1 }],
    remainder: partial,
  });
});

test("handles crlf line endings in chunk decoder", () => {
  const raw = `${encodeMessage({ type: "heartbeat", sentAt: 1 }).replace(/\n/g, "\r\n")}${encodeMessage({
    type: "error",
    message: "failed",
  }).replace(/\n/g, "\r\n")}`;

  expect(decodeMessageChunk(raw)).toEqual({
    messages: [
      { type: "heartbeat", sentAt: 1 },
      { type: "error", message: "failed" },
    ],
    remainder: "",
  });
});

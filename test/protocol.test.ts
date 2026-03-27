import { expect, test } from "bun:test";
import { decodeMessages, encodeMessage } from "../src/protocol";

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

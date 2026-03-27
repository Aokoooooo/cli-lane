import { expect, test } from "bun:test";
import { decodeMessages, encodeMessage } from "../src/protocol";

test("encodes and decodes hello messages", () => {
  const raw = encodeMessage({ type: "hello", clientVersion: "1.0.0" });
  const messages = decodeMessages(raw);

  expect(messages).toEqual([{ type: "hello", clientVersion: "1.0.0" }]);
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

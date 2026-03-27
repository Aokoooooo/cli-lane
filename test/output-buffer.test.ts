import { expect, test } from "bun:test";
import { OutputBuffer } from "../src/output-buffer";

test("replays buffered chunks in sequence order", () => {
  const buffer = new OutputBuffer(1024);

  buffer.append("stdout", "a");
  buffer.append("stderr", "b");

  expect(buffer.lastSeq()).toBe(2);
  expect(buffer.snapshotUntil(buffer.lastSeq())).toEqual([
    { seq: 1, stream: "stdout", data: "a" },
    { seq: 2, stream: "stderr", data: "b" },
  ]);
});

test("replays chunks only up to the requested sequence", () => {
  const buffer = new OutputBuffer(1024);

  buffer.append("stdout", "a");
  buffer.append("stderr", "b");
  buffer.append("stdout", "c");

  expect(buffer.snapshotUntil(2)).toEqual([
    { seq: 1, stream: "stdout", data: "a" },
    { seq: 2, stream: "stderr", data: "b" },
  ]);
  expect(buffer.snapshotUntil(buffer.lastSeq())).toEqual([
    { seq: 1, stream: "stdout", data: "a" },
    { seq: 2, stream: "stderr", data: "b" },
    { seq: 3, stream: "stdout", data: "c" },
  ]);
});

test("trims whole chunks without splitting data", () => {
  const buffer = new OutputBuffer(4);

  buffer.append("stdout", "aa");
  buffer.append("stderr", "bb");
  buffer.append("stdout", "cc");
  buffer.trimToBudget();

  expect(buffer.snapshotUntil(buffer.lastSeq())).toEqual([
    { seq: 2, stream: "stderr", data: "bb" },
    { seq: 3, stream: "stdout", data: "cc" },
  ]);
});

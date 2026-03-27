import { expect, test } from "bun:test";
import { OutputBuffer } from "../src/output-buffer";

test("replays buffered chunks in sequence order", () => {
  const buffer = new OutputBuffer(1024);

  buffer.append("stdout", "a");
  buffer.append("stderr", "b");

  expect(buffer.lastSeq()).toBe(2);
  expect(buffer.firstRetainedSeq()).toBe(1);
  expect(buffer.snapshotAfter(0)).toEqual([
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

test("exposes the retained window after trimming", () => {
  const buffer = new OutputBuffer(4);

  buffer.append("stdout", "aa");
  buffer.append("stderr", "bb");
  buffer.append("stdout", "cc");

  expect(buffer.firstRetainedSeq()).toBe(2);
  expect(buffer.snapshotAfter(1)).toEqual([
    { seq: 2, stream: "stderr", data: "bb" },
    { seq: 3, stream: "stdout", data: "cc" },
  ]);
});

test("replays incrementally without duplicating chunks", () => {
  const buffer = new OutputBuffer(1024);

  buffer.append("stdout", "a");
  buffer.append("stderr", "b");
  buffer.append("stdout", "c");

  expect(buffer.snapshotAfter(0)).toEqual([
    { seq: 1, stream: "stdout", data: "a" },
    { seq: 2, stream: "stderr", data: "b" },
    { seq: 3, stream: "stdout", data: "c" },
  ]);

  buffer.append("stderr", "d");

  expect(buffer.snapshotAfter(3)).toEqual([
    { seq: 4, stream: "stderr", data: "d" },
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

test("retains an oversized single chunk without splitting it", () => {
  const buffer = new OutputBuffer(4);

  buffer.append("stdout", "abcdef");

  expect(buffer.firstRetainedSeq()).toBe(1);
  expect(buffer.snapshotAfter(0)).toEqual([
    { seq: 1, stream: "stdout", data: "abcdef" },
  ]);
});

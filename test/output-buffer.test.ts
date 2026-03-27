import { expect, test } from "bun:test";
import { OutputBuffer } from "../src/output-buffer";

function chunk(seq: number, stream: "stdout" | "stderr", data: string) {
  return {
    seq,
    stream,
    data,
    ts: expect.any(Number),
    bytes: Buffer.byteLength(data),
  };
}

test("replays buffered chunks in sequence order", () => {
  const buffer = new OutputBuffer(1024);

  buffer.append("stdout", "a");
  buffer.append("stderr", "b");

  expect(buffer.lastSeq()).toBe(2);
  expect(buffer.firstRetainedSeq()).toBe(1);
  expect(buffer.snapshotAfter(0)).toEqual([
    chunk(1, "stdout", "a"),
    chunk(2, "stderr", "b"),
  ]);
});

test("replays chunks only up to the requested sequence", () => {
  const buffer = new OutputBuffer(1024);

  buffer.append("stdout", "a");
  buffer.append("stderr", "b");
  buffer.append("stdout", "c");

  expect(buffer.snapshotUntil(2)).toEqual([
    chunk(1, "stdout", "a"),
    chunk(2, "stderr", "b"),
  ]);
  expect(buffer.snapshotUntil(buffer.lastSeq())).toEqual([
    chunk(1, "stdout", "a"),
    chunk(2, "stderr", "b"),
    chunk(3, "stdout", "c"),
  ]);
});

test("exposes the retained window after trimming", () => {
  const buffer = new OutputBuffer(4);

  buffer.append("stdout", "aa");
  buffer.append("stderr", "bb");
  buffer.append("stdout", "cc");

  expect(buffer.firstRetainedSeq()).toBe(2);
  expect(buffer.snapshotAfter(1)).toEqual([
    chunk(2, "stderr", "bb"),
    chunk(3, "stdout", "cc"),
  ]);
});

test("replays incrementally without duplicating chunks", () => {
  const buffer = new OutputBuffer(1024);

  buffer.append("stdout", "a");
  buffer.append("stderr", "b");
  buffer.append("stdout", "c");

  expect(buffer.snapshotAfter(0)).toEqual([
    chunk(1, "stdout", "a"),
    chunk(2, "stderr", "b"),
    chunk(3, "stdout", "c"),
  ]);

  buffer.append("stderr", "d");

  expect(buffer.snapshotAfter(3)).toEqual([
    chunk(4, "stderr", "d"),
  ]);
});

test("trims whole chunks without splitting data", () => {
  const buffer = new OutputBuffer(4);

  buffer.append("stdout", "aa");
  buffer.append("stderr", "bb");
  buffer.append("stdout", "cc");
  buffer.trimToBudget();

  expect(buffer.snapshotUntil(buffer.lastSeq())).toEqual([
    chunk(2, "stderr", "bb"),
    chunk(3, "stdout", "cc"),
  ]);
});

test("retains an oversized single chunk without splitting it", () => {
  const buffer = new OutputBuffer(4);

  buffer.append("stdout", "abcdef");

  expect(buffer.firstRetainedSeq()).toBe(1);
  expect(buffer.snapshotAfter(0)).toEqual([
    chunk(1, "stdout", "abcdef"),
  ]);
});

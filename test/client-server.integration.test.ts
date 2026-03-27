import { expect, test } from "bun:test";
import { runProcess, terminateProcess } from "../src/process-runner";

test("captures stdout, stderr, callbacks, and exit code", async () => {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const result = await runProcess({
    cwd: process.cwd(),
    argv: [
      "bun",
      "-e",
      [
        "process.stdout.write('out:1\\n');",
        "process.stderr.write('err:1\\n');",
        "process.stdout.write('out:2\\n');",
        "process.exit(3);",
      ].join(""),
    ],
    onStdout(chunk) {
      stdoutChunks.push(chunk);
    },
    onStderr(chunk) {
      stderrChunks.push(chunk);
    },
  });

  expect(result.code).toBe(3);
  expect(result.signal).toBeNull();
  expect(result.stdout).toBe("out:1\nout:2\n");
  expect(result.stderr).toBe("err:1\n");
  expect(stdoutChunks.join("")).toBe(result.stdout);
  expect(stderrChunks.join("")).toBe(result.stderr);
});

test("gracefully stops on abort signal", async () => {
  const controller = new AbortController();
  let ready = false;

  const runPromise = runProcess({
    cwd: process.cwd(),
    argv: [
      "bun",
      "-e",
      [
        "process.stdout.write('ready\\n');",
        "process.on('SIGTERM', () => {",
        "  process.stdout.write('stopping\\n');",
        "  setTimeout(() => process.exit(0), 25);",
        "});",
        "setInterval(() => {}, 1000);",
      ].join(""),
    ],
    signal: controller.signal,
    onStdout(chunk) {
      if (!ready && chunk.includes("ready")) {
        ready = true;
        controller.abort();
      }
    },
  });

  const result = await runPromise;

  expect(ready).toBe(true);
  expect(result.code).toBe(0);
  expect(result.signal).toBeNull();
  expect(result.stdout).toContain("ready\n");
  expect(result.stdout).toContain("stopping\n");
});

test("force kills the process after the graceful timeout", async () => {
  const controller = new AbortController();
  let ready = false;

  const resultPromise = runProcess({
    cwd: process.cwd(),
    argv: [
      "bun",
      "-e",
      [
        "process.stdout.write('ready\\n');",
        "process.on('SIGTERM', () => {",
        "  process.stdout.write('ignoring\\n');",
        "});",
        "setInterval(() => {}, 1000);",
      ].join(""),
    ],
    signal: controller.signal,
    onStdout(chunk) {
      if (!ready && chunk.includes("ready")) {
        ready = true;
        controller.abort();
      }
    },
  });

  const result = await resultPromise;

  expect(ready).toBe(true);
  expect(result.stdout).toContain("ready\n");
  expect(result.stdout).toContain("ignoring\n");
  expect(result.code).not.toBe(0);
  expect(result.signal).toBe("SIGKILL");
});

test("uses the default graceful timeout when no graceMs is provided", async () => {
  const controller = new AbortController();
  let ready = false;

  const resultPromise = runProcess({
    cwd: process.cwd(),
    argv: [
      "bun",
      "-e",
      [
        "process.stdout.write('ready\\n');",
        "process.on('SIGTERM', () => {",
        "  setTimeout(() => process.exit(0), 200);",
        "});",
        "setInterval(() => {}, 1000);",
      ].join(""),
    ],
    signal: controller.signal,
    onStdout(chunk) {
      if (!ready && chunk.includes("ready")) {
        ready = true;
        controller.abort();
      }
    },
  });

  const result = await resultPromise;

  expect(ready).toBe(true);
  expect(result.code).toBe(0);
  expect(result.signal).toBeNull();
});

test("surfaces terminateProcess kill failures", async () => {
  const expected = new Error("kill failed");
  const proc = {
    exitCode: null,
    signalCode: null,
    exited: new Promise<number | null>(() => {}),
    kill() {
      throw expected;
    },
  };

  await expect(terminateProcess(proc as unknown as Bun.Subprocess, 10)).rejects.toBe(expected);
});

test("runProcess rejects promptly when termination fails in-flight", async () => {
  const originalSpawn = Bun.spawn;
  const controller = new AbortController();
  const expected = new Error("kill failed");

  const fakeProc = {
    stdout: new ReadableStream<Uint8Array>({
      start() {},
    }),
    stderr: new ReadableStream<Uint8Array>({
      start() {},
    }),
    stdin: null,
    exited: new Promise<number | null>(() => {}),
    exitCode: null,
    signalCode: null,
    kill() {
      throw expected;
    },
  };

  Bun.spawn = (() => fakeProc) as typeof Bun.spawn;

  try {
    const runPromise = runProcess({
      cwd: process.cwd(),
      argv: ["bun", "-e", "setInterval(() => {}, 1000)"],
      signal: controller.signal,
    });

    controller.abort();

    await expect(runPromise).rejects.toBe(expected);
  } finally {
    Bun.spawn = originalSpawn;
  }
});

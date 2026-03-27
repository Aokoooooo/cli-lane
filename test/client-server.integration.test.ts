import { expect, test } from "bun:test";
import { runProcess } from "../src/process-runner";

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

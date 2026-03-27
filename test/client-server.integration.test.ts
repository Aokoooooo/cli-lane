import { afterEach, expect, test } from "bun:test";
import { createConnection, Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runProcess, terminateProcess } from "../src/process-runner";
import { decodeMessageChunk, encodeMessage, protocolVersion } from "../src/protocol";
import { readRegistration } from "../src/registry";
import { startServer } from "../src/server";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "cli-lane-server-test-"));
  tempDirs.push(dir);
  return dir;
}

type ServerSession = {
  socket: Socket;
  send: (message: unknown) => void;
  nextMessage: () => Promise<unknown>;
  close: () => Promise<void>;
};

async function nextMessageWithin(session: ServerSession, timeoutMs = 1_000): Promise<unknown> {
  return await Promise.race([
    session.nextMessage(),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

async function waitForMessage(
  session: ServerSession,
  predicate: (message: unknown) => boolean,
  timeoutMs = 1_500,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const message = await nextMessageWithin(session, Math.max(1, deadline - Date.now()));
    if (predicate(message)) {
      return message;
    }
  }

  throw new Error(`timed out after ${timeoutMs}ms`);
}

async function connectToServer(port: number): Promise<ServerSession> {
  const socket = createConnection({ host: "127.0.0.1", port });
  const queue: unknown[] = [];
  const waiters: Array<(message: unknown) => void> = [];
  let buffer = "";

  socket.setEncoding("utf8");

  socket.on("data", (chunk: string) => {
    buffer += chunk;
    const decoded = decodeMessageChunk(buffer);
    buffer = decoded.remainder;

    for (const message of decoded.messages) {
      const next = waiters.shift();
      if (next) {
        next(message);
      } else {
        queue.push(message);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });

  return {
    socket,
    send(message) {
      socket.write(encodeMessage(message as never));
    },
    nextMessage() {
      const queued = queue.shift();
      if (queued !== undefined) {
        return Promise.resolve(queued);
      }

      return new Promise<unknown>((resolve) => {
        waiters.push(resolve);
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.end();
        setTimeout(() => {
          if (!socket.destroyed) {
            socket.destroy();
          }
        }, 25);
      });
    },
  };
}

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

test("starts the coordinator server and writes registration", async () => {
  const runtimeDir = await createTempDir();
  const server = await startServer({ runtimeDir });

  try {
    expect(server.port).toBeGreaterThan(0);
    expect(server.registration.port).toBe(server.port);
    expect(server.registration.protocolVersion).toBe(protocolVersion);
    expect(await readRegistration(server.registrationPath)).toEqual(server.registration);
  } finally {
    await server.stop();
  }
});

test("handshakes hello and heartbeat over TCP", async () => {
  const runtimeDir = await createTempDir();
  const server = await startServer({ runtimeDir });

  try {
    const session = await connectToServer(server.port);

    session.send({
      type: "hello",
      token: server.registration.token,
      protocolVersion,
      clientVersion: "1.0.0",
    });

    expect(await session.nextMessage()).toEqual({
      type: "hello-ack",
      serverVersion: expect.any(String),
      protocolVersion,
    });

    session.send({ type: "heartbeat", sentAt: 123 });

    expect(await session.nextMessage()).toEqual({
      type: "heartbeat-ack",
      sentAt: 123,
      serverTime: expect.any(Number),
    });

  } finally {
    await server.stop();
  }
});

test("accepts run requests and surfaces active work in ps", async () => {
  const runtimeDir = await createTempDir();
  const server = await startServer({ runtimeDir });

  try {
    const session = await connectToServer(server.port);
    session.send({
      type: "hello",
      token: server.registration.token,
      protocolVersion,
      clientVersion: "1.0.0",
    });
    await session.nextMessage();

    const requestId = "req-1";
    session.send({
      type: "run",
      requestId,
      cwd: process.cwd(),
      argv: ["bun", "-e", "setTimeout(() => process.exit(0), 50);"],
      serialMode: "global",
      mergeMode: "by-cwd",
    });

    const accepted = await session.nextMessage();
    expect(accepted).toEqual({
      type: "accepted",
      requestId,
      taskId: expect.any(String),
      subscriberId: expect.any(String),
      merged: false,
    });

    session.send({ type: "ps", requestId: "ps-1" });

    const messages = [await session.nextMessage(), await session.nextMessage()];
    expect(messages).toContainEqual({
      type: "ps-result",
      requestId: "ps-1",
      tasks: [
        {
          taskId: (accepted as { taskId: string }).taskId,
          status: "running",
          cwd: process.cwd(),
          argv: ["bun", "-e", "setTimeout(() => process.exit(0), 50);"],
          subscriberCount: 1,
          merged: false,
        },
      ],
    });
    expect(messages).toContainEqual({
      type: "task-event",
      taskId: (accepted as { taskId: string }).taskId,
      event: {
        type: "started",
      },
    });

    await session.close();
  } finally {
    await server.stop();
  }
});

test("cancels a running task through cancel-task", async () => {
  const runtimeDir = await createTempDir();
  const server = await startServer({ runtimeDir, terminateGraceMs: 50 });

  try {
    const session = await connectToServer(server.port);
    session.send({
      type: "hello",
      token: server.registration.token,
      protocolVersion,
      clientVersion: "1.0.0",
    });
    await session.nextMessage();

    const requestId = "req-cancel";
    session.send({
      type: "run",
      requestId,
      cwd: process.cwd(),
      argv: [
        "bun",
        "-e",
        [
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
        ].join(""),
      ],
      serialMode: "global",
      mergeMode: "by-cwd",
    });

    const accepted = await session.nextMessage();
    expect(accepted).toEqual({
      type: "accepted",
      requestId,
      taskId: expect.any(String),
      subscriberId: expect.any(String),
      merged: false,
    });

    const started = await session.nextMessage();
    expect(started).toEqual({
      type: "task-event",
      taskId: (accepted as { taskId: string }).taskId,
      event: {
        type: "started",
      },
    });

    session.send({
      type: "cancel-task",
      taskId: (accepted as { taskId: string }).taskId,
    });

    const cancelled = await session.nextMessage();
    expect(cancelled).toEqual({
      type: "task-event",
      taskId: (accepted as { taskId: string }).taskId,
      event: {
        type: "cancelled",
      },
    });

    await session.close();
  } finally {
    await server.stop();
  }
});

test("replays buffered output to a late-joining merged subscriber", async () => {
  const runtimeDir = await createTempDir();
  const server = await startServer({ runtimeDir });

  try {
    const sessionA = await connectToServer(server.port);
    sessionA.send({
      type: "hello",
      token: server.registration.token,
      protocolVersion,
      clientVersion: "1.0.0",
    });
    await nextMessageWithin(sessionA);

    sessionA.send({
      type: "run",
      requestId: "req-a",
      cwd: process.cwd(),
      argv: [
        "bun",
        "-e",
        [
          "process.stdout.write('first\\n');",
          "setTimeout(() => process.stderr.write('err\\n'), 30);",
          "setTimeout(() => process.stdout.write('second\\n'), 60);",
          "setTimeout(() => process.exit(0), 90);",
        ].join(""),
      ],
      serialMode: "global",
      mergeMode: "by-cwd",
    });

    const acceptedA = await nextMessageWithin(sessionA);
    expect(acceptedA).toEqual({
      type: "accepted",
      requestId: "req-a",
      taskId: expect.any(String),
      subscriberId: expect.any(String),
      merged: false,
    });

    await waitForMessage(
      sessionA,
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        (message as { type?: string }).type === "task-event" &&
        typeof (message as { event?: { type?: string; data?: string } }).event === "object" &&
        (message as { event: { type?: string; data?: string } }).event.type === "stdout" &&
        (message as { event: { data?: string } }).event.data === "first\n",
    );

    const sessionB = await connectToServer(server.port);
    sessionB.send({
      type: "hello",
      token: server.registration.token,
      protocolVersion,
      clientVersion: "1.0.0",
    });
    await nextMessageWithin(sessionB);

    sessionB.send({
      type: "run",
      requestId: "req-b",
      cwd: process.cwd(),
      argv: [
        "bun",
        "-e",
        [
          "process.stdout.write('first\\n');",
          "setTimeout(() => process.stderr.write('err\\n'), 30);",
          "setTimeout(() => process.stdout.write('second\\n'), 60);",
          "setTimeout(() => process.exit(0), 90);",
        ].join(""),
      ],
      serialMode: "global",
      mergeMode: "by-cwd",
    });

    const acceptedB = await nextMessageWithin(sessionB);
    expect(acceptedB).toEqual({
      type: "accepted",
      requestId: "req-b",
      taskId: (acceptedA as { taskId: string }).taskId,
      subscriberId: expect.any(String),
      merged: true,
    });

    expect(
      await waitForMessage(
        sessionB,
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          (message as { type?: string }).type === "task-event" &&
          typeof (message as { event?: { type?: string; data?: string; replay?: boolean } }).event === "object" &&
          (message as { event: { type?: string; data?: string; replay?: boolean } }).event.type === "stdout" &&
          (message as { event: { data?: string; replay?: boolean } }).event.data === "first\n" &&
          (message as { event: { replay?: boolean } }).event.replay === true,
      ),
    ).toEqual({
      type: "task-event",
      taskId: (acceptedA as { taskId: string }).taskId,
      event: {
        type: "stdout",
        data: "first\n",
        replay: true,
        seq: 1,
      },
    });

    expect(
      await waitForMessage(
        sessionB,
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          (message as { type?: string }).type === "task-event" &&
          typeof (message as { event?: { type?: string; data?: string } }).event === "object" &&
          (message as { event: { type?: string; data?: string } }).event.type === "stderr" &&
          (message as { event: { data?: string } }).event.data === "err\n",
      ),
    ).toEqual({
      type: "task-event",
      taskId: (acceptedA as { taskId: string }).taskId,
      event: {
        type: "stderr",
        data: "err\n",
        replay: false,
        seq: 2,
      },
    });

    await sessionA.close();
    await sessionB.close();
  } finally {
    await server.stop();
  }
});

test("ps returns rich task summaries including queue position", async () => {
  const runtimeDir = await createTempDir();
  const server = await startServer({ runtimeDir });

  try {
    const session = await connectToServer(server.port);
    session.send({
      type: "hello",
      token: server.registration.token,
      protocolVersion,
      clientVersion: "1.0.0",
    });
    await nextMessageWithin(session);

    session.send({
      type: "run",
      requestId: "req-running",
      cwd: process.cwd(),
      argv: [
        "bun",
        "-e",
        "setTimeout(() => process.exit(0), 200);",
      ],
      serialMode: "global",
      mergeMode: "by-cwd",
    });
    const runningAccepted = await nextMessageWithin(session);
    await waitForMessage(
      session,
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        (message as { type?: string }).type === "task-event" &&
        typeof (message as { event?: { type?: string } }).event === "object" &&
        (message as { event: { type?: string } }).event.type === "started",
    );

    session.send({
      type: "run",
      requestId: "req-queued",
      cwd: process.cwd(),
      argv: [
        "bun",
        "-e",
        "setTimeout(() => process.exit(0), 50);",
      ],
      serialMode: "global",
      mergeMode: "by-cwd",
    });
    const queuedAccepted = await nextMessageWithin(session);
    await waitForMessage(
      session,
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        (message as { type?: string }).type === "task-event" &&
        typeof (message as { event?: { type?: string; position?: number } }).event === "object" &&
        (message as { event: { type?: string; position?: number } }).event.type === "queued" &&
        (message as { event: { position?: number } }).event.position === 2,
    );

    session.send({ type: "ps", requestId: "ps-rich" });

    expect(
      await waitForMessage(
        session,
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          (message as { type?: string }).type === "ps-result" &&
          (message as { requestId?: string }).requestId === "ps-rich",
      ),
    ).toEqual({
      type: "ps-result",
      requestId: "ps-rich",
      tasks: [
        {
          taskId: (runningAccepted as { taskId: string }).taskId,
          status: "running",
          cwd: process.cwd(),
          argv: ["bun", "-e", "setTimeout(() => process.exit(0), 200);"],
          subscriberCount: 1,
          merged: false,
        },
        {
          taskId: (queuedAccepted as { taskId: string }).taskId,
          status: "queued",
          cwd: process.cwd(),
          argv: ["bun", "-e", "setTimeout(() => process.exit(0), 50);"],
          subscriberCount: 1,
          merged: false,
          queuePosition: 2,
        },
      ],
    });

    await session.close();
  } finally {
    await server.stop();
  }
});

test("shuts itself down after the idle timeout and cleans registration", async () => {
  const runtimeDir = await createTempDir();
  const server = await startServer({ runtimeDir, idleTimeoutMs: 50 });

  expect(await readRegistration(server.registrationPath)).toEqual(server.registration);

  await new Promise((resolve) => setTimeout(resolve, 150));

  expect(await readRegistration(server.registrationPath)).toBeNull();
  await expect(connectToServer(server.port)).rejects.toThrow();
  await server.stop();
});

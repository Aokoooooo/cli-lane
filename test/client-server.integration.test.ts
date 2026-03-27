import { afterEach, expect, test } from "bun:test";
import { createConnection, Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "../src/cli";
import { createClient } from "../src/client";
import { loadConfig } from "../src/config";
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
  closed: Promise<void>;
};

type MessageCollector = {
  push: (message: unknown) => void;
  nextMessage: () => Promise<unknown>;
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

async function waitForCollectedMessage(
  collector: MessageCollector,
  predicate: (message: unknown) => boolean,
  timeoutMs = 1_500,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const message = await Promise.race([
      collector.nextMessage(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);

    if (predicate(message)) {
      return message;
    }
  }

  throw new Error(`timed out after ${timeoutMs}ms`);
}

function createMessageCollector(): MessageCollector {
  const queue: unknown[] = [];
  const waiters: Array<(message: unknown) => void> = [];

  return {
    push(message) {
      const next = waiters.shift();
      if (next) {
        next(message);
      } else {
        queue.push(message);
      }
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
  };
}

function createCapturedWriter() {
  const chunks: string[] = [];

  return {
    write(chunk: string) {
      chunks.push(chunk);
    },
    toString() {
      return chunks.join("");
    },
  };
}

async function connectToServer(port: number): Promise<ServerSession> {
  const socket = createConnection({ host: "127.0.0.1", port });
  const queue: unknown[] = [];
  const waiters: Array<(message: unknown) => void> = [];
  let buffer = "";
  const closed = new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
  });

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
    closed,
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
      executionCwd: process.cwd(),
      requestedCwd: process.cwd(),
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
      executionCwd: process.cwd(),
      requestedCwd: process.cwd(),
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
      executionCwd: process.cwd(),
      requestedCwd: process.cwd(),
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
      executionCwd: process.cwd(),
      requestedCwd: process.cwd(),
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
        ts: expect.any(Number),
        bytes: Buffer.byteLength("first\n"),
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
        ts: expect.any(Number),
        bytes: Buffer.byteLength("err\n"),
      },
    });

    await sessionA.close();
    await sessionB.close();
  } finally {
    await server.stop();
  }
});

test("accepted message exposes execution cwd and requested cwd for global merges", async () => {
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
      requestId: "req-global-a",
      cwd: process.cwd(),
      argv: ["bun", "-e", "setTimeout(() => process.exit(0), 80);"],
      serialMode: "global",
      mergeMode: "global",
    });

    const acceptedA = await nextMessageWithin(sessionA);
    expect(acceptedA).toEqual({
      type: "accepted",
      requestId: "req-global-a",
      taskId: expect.any(String),
      subscriberId: expect.any(String),
      merged: false,
      executionCwd: process.cwd(),
      requestedCwd: process.cwd(),
    });

    const otherCwd = `${process.cwd()}/./test/..`;
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
      requestId: "req-global-b",
      cwd: otherCwd,
      argv: ["bun", "-e", "setTimeout(() => process.exit(0), 80);"],
      serialMode: "global",
      mergeMode: "global",
    });

    expect(await nextMessageWithin(sessionB)).toEqual({
      type: "accepted",
      requestId: "req-global-b",
      taskId: (acceptedA as { taskId: string }).taskId,
      subscriberId: expect.any(String),
      merged: true,
      executionCwd: process.cwd(),
      requestedCwd: otherCwd,
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

test("cancel-subscription detaches only the targeted subscriber", async () => {
  const runtimeDir = await createTempDir();
  const server = await startServer({ runtimeDir, terminateGraceMs: 50 });

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
      argv: ["bun", "-e", "setInterval(() => {}, 1000);"],
      serialMode: "global",
      mergeMode: "by-cwd",
    });

    const acceptedA = await nextMessageWithin(sessionA) as {
      taskId: string;
      subscriberId: string;
    };

    await waitForMessage(
      sessionA,
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        (message as { type?: string }).type === "task-event" &&
        typeof (message as { event?: { type?: string } }).event === "object" &&
        (message as { event: { type?: string } }).event.type === "started",
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
      argv: ["bun", "-e", "setInterval(() => {}, 1000);"],
      serialMode: "global",
      mergeMode: "by-cwd",
    });

    const acceptedB = await nextMessageWithin(sessionB) as {
      taskId: string;
      subscriberId: string;
    };

    expect(acceptedB.taskId).toBe(acceptedA.taskId);

    sessionB.send({
      type: "cancel-subscription",
      taskId: acceptedB.taskId,
      subscriberId: acceptedB.subscriberId,
    });

    expect(await nextMessageWithin(sessionB)).toEqual({
      type: "subscription-detached",
      taskId: acceptedB.taskId,
      subscriberId: acceptedB.subscriberId,
      remainingSubscribers: 1,
      taskStillRunning: true,
    });

    sessionA.send({ type: "ps", requestId: "ps-still-running" });
    expect(
      await waitForMessage(
        sessionA,
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          (message as { type?: string }).type === "ps-result" &&
          (message as { requestId?: string }).requestId === "ps-still-running",
      ),
    ).toEqual({
      type: "ps-result",
      requestId: "ps-still-running",
      tasks: [
        {
          taskId: acceptedA.taskId,
          status: "running",
          cwd: process.cwd(),
          argv: ["bun", "-e", "setInterval(() => {}, 1000);"],
          subscriberCount: 1,
          merged: false,
        },
      ],
    });

    sessionA.send({
      type: "cancel-subscription",
      taskId: acceptedA.taskId,
      subscriberId: acceptedA.subscriberId,
    });

    expect(
      await waitForMessage(
        sessionA,
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          (message as { type?: string }).type === "task-event" &&
          typeof (message as { event?: { type?: string } }).event === "object" &&
          (message as { event: { type?: string } }).event.type === "cancelled",
      ),
    ).toEqual({
      type: "task-event",
      taskId: acceptedA.taskId,
      event: {
        type: "cancelled",
      },
    });

    await sessionA.close();
    await sessionB.close();
  } finally {
    await server.stop();
  }
});

test("missed heartbeats detach the attached subscriber and auto-cancel the task", async () => {
  const runtimeDir = await createTempDir();
  const server = await startServer({
    runtimeDir,
    terminateGraceMs: 50,
    idleTimeoutMs: 5_000,
    heartbeatTimeoutMs: 80,
  } as Parameters<typeof startServer>[0]);

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
      requestId: "req-heartbeat",
      cwd: process.cwd(),
      argv: ["bun", "-e", "setInterval(() => {}, 1000);"],
      serialMode: "global",
      mergeMode: "by-cwd",
    });

    const accepted = await nextMessageWithin(session) as { taskId: string };
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

    session.send({ type: "heartbeat", sentAt: 1 });
    expect(await nextMessageWithin(session)).toEqual({
      type: "heartbeat-ack",
      sentAt: 1,
      serverTime: expect.any(Number),
    });

    expect(
      await waitForMessage(
        session,
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          (message as { type?: string }).type === "task-event" &&
          typeof (message as { event?: { type?: string } }).event === "object" &&
          (message as { event: { type?: string } }).event.type === "cancelled",
        1_000,
      ),
    ).toEqual({
      type: "task-event",
      taskId: accepted.taskId,
      event: {
        type: "cancelled",
      },
    });
  } finally {
    await server.stop();
  }
});

test("disconnecting during run normalization does not leave a zombie subscriber", async () => {
  const runtimeDir = await createTempDir();
  const server = await startServer({ runtimeDir, idleTimeoutMs: 5_000 });

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
      requestId: "req-zombie",
      cwd: join(process.cwd(), ".", "test", ".."),
      argv: ["bun", "-e", "setTimeout(() => process.exit(0), 250);"],
      serialMode: "global",
      mergeMode: "by-cwd",
    });

    await session.close();

    const inspector = await connectToServer(server.port);
    inspector.send({
      type: "hello",
      token: server.registration.token,
      protocolVersion,
      clientVersion: "1.0.0",
    });
    await nextMessageWithin(inspector);

    await new Promise((resolve) => setTimeout(resolve, 50));

    inspector.send({ type: "ps", requestId: "ps-zombie" });
    expect(await nextMessageWithin(inspector)).toEqual({
      type: "ps-result",
      requestId: "ps-zombie",
      tasks: [],
    });

    await inspector.close();
  } finally {
    await server.stop();
  }
});

test("unauthenticated connections time out and do not block idle shutdown", async () => {
  const runtimeDir = await createTempDir();
  const server = await startServer({
    runtimeDir,
    idleTimeoutMs: 50,
    heartbeatTimeoutMs: 500,
  });

  const session = await connectToServer(server.port);

  await expect(session.closed).resolves.toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 100));

  expect(await readRegistration(server.registrationPath)).toBeNull();
  await expect(connectToServer(server.port)).rejects.toThrow();
  await server.stop();
});

test("createClient can bootstrap a coordinator and keep it alive with heartbeats", async () => {
  const runtimeDir = await createTempDir();
  const client = await createClient({
    runtimeDir,
    heartbeatIntervalMs: 20,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 120));

    const ps = await client.ps();
    expect(ps).toEqual({
      type: "ps-result",
      requestId: expect.any(String),
      tasks: [],
    });
  } finally {
    await client.close();
  }
});

test("createClient can run commands and detach subscriptions explicitly", async () => {
  const runtimeDir = await createTempDir();
  const server = await startServer({
    runtimeDir,
    terminateGraceMs: 50,
    heartbeatTimeoutMs: 5_000,
  });

  const collector = createMessageCollector();
  const client = await createClient({
    runtimeDir,
    heartbeatIntervalMs: 20,
    onMessage(message) {
      collector.push(message);
    },
  });

  try {
    const accepted = await client.run({
      cwd: process.cwd(),
      argv: [
        "bun",
        "-e",
        [
          "process.stdout.write('hello\\n');",
          "setInterval(() => {}, 1000);",
        ].join(""),
      ],
      serialMode: "global",
      mergeMode: "by-cwd",
    });

    expect(accepted).toEqual({
      type: "accepted",
      requestId: expect.any(String),
      taskId: expect.any(String),
      subscriberId: expect.any(String),
      merged: false,
      executionCwd: process.cwd(),
      requestedCwd: process.cwd(),
    });

    expect(
      await waitForCollectedMessage(
        collector,
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          (message as { type?: string }).type === "task-event" &&
          (message as { event?: { type?: string } }).event?.type === "stdout",
      ),
    ).toEqual({
      type: "task-event",
      taskId: accepted.taskId,
      event: {
        type: "stdout",
        data: "hello\n",
        seq: 1,
        ts: expect.any(Number),
        bytes: 6,
        replay: false,
      },
    });

    const detachedPromise = waitForCollectedMessage(
      collector,
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        (message as { type?: string }).type === "subscription-detached" &&
        (message as { taskId?: string }).taskId === accepted.taskId,
    );

    const detached = await client.cancelSubscription(accepted.taskId, accepted.subscriberId);
    expect(detached).toEqual({
      type: "subscription-detached",
      taskId: accepted.taskId,
      subscriberId: accepted.subscriberId,
      remainingSubscribers: 0,
      taskStillRunning: false,
    });
    expect(await detachedPromise).toEqual(detached);

    const cancelAccepted = await client.run({
      cwd: process.cwd(),
      argv: [
        "bun",
        "-e",
        "setInterval(() => {}, 1000);",
      ],
      serialMode: "global",
      mergeMode: "by-cwd",
    });

    const cancelledPromise = waitForCollectedMessage(
      collector,
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        (message as { type?: string }).type === "task-event" &&
        typeof (message as { event?: { type?: string } }).event === "object" &&
        (message as { event: { type?: string } }).event.type === "cancelled" &&
        (message as { taskId?: string }).taskId === cancelAccepted.taskId,
    );

    await client.cancelTask(cancelAccepted.taskId);
    expect(await cancelledPromise).toEqual({
      type: "task-event",
      taskId: cancelAccepted.taskId,
      event: {
        type: "cancelled",
      },
    });
  } finally {
    await client.close();
    await server.stop();
  }
});

test("createClient surfaces a notice when explicit detach leaves the task running", async () => {
  const runtimeDir = await createTempDir();
  const server = await startServer({
    runtimeDir,
    terminateGraceMs: 50,
    heartbeatTimeoutMs: 5_000,
  });

  const notices: Array<{ type: string; message: string }> = [];
  const client = await createClient({
    runtimeDir,
    heartbeatIntervalMs: 20,
    onNotice(notice) {
      notices.push(notice);
    },
  });

  try {
    const accepted = await client.run({
      cwd: process.cwd(),
      argv: [
        "bun",
        "-e",
        "setInterval(() => {}, 1000);",
      ],
      serialMode: "global",
      mergeMode: "by-cwd",
    });

    const merged = await client.run({
      cwd: process.cwd(),
      argv: [
        "bun",
        "-e",
        "setInterval(() => {}, 1000);",
      ],
      serialMode: "global",
      mergeMode: "by-cwd",
    });

    const detached = await client.cancelSubscription(merged.taskId, merged.subscriberId);
    expect(detached.taskStillRunning).toBe(true);
    expect(detached.remainingSubscribers).toBe(1);
    expect(notices).toContainEqual({
      type: "notice",
      kind: "subscription-detached",
      message: expect.stringContaining("Detached from task"),
      taskId: merged.taskId,
      subscriberId: merged.subscriberId,
      remainingSubscribers: 1,
      taskStillRunning: true,
    });
  } finally {
    await client.close();
    await server.stop();
  }
});

test("createClient surfaces a notice for global merge cwd mismatch", async () => {
  const runtimeDir = await createTempDir();
  const alternateCwd = await createTempDir();
  const server = await startServer({
    runtimeDir,
    terminateGraceMs: 50,
    heartbeatTimeoutMs: 5_000,
  });

  const notices: Array<{ type: string; message: string }> = [];
  const client = await createClient({
    runtimeDir,
    heartbeatIntervalMs: 20,
    onNotice(notice) {
      notices.push(notice);
    },
  });

  try {
    const first = await client.run({
      cwd: process.cwd(),
      argv: [
        "bun",
        "-e",
        "setTimeout(() => process.exit(0), 120);",
      ],
      serialMode: "global",
      mergeMode: "global",
    });

    await client.run({
      cwd: alternateCwd,
      argv: [
        "bun",
        "-e",
        "setTimeout(() => process.exit(0), 120);",
      ],
      serialMode: "global",
      mergeMode: "global",
    });

    expect(notices).toContainEqual({
      type: "notice",
      kind: "cwd-mismatch",
      message: expect.stringContaining("executing in"),
      taskId: first.taskId,
      executionCwd: process.cwd(),
      requestedCwd: alternateCwd,
    });
  } finally {
    await client.close();
    await server.stop();
  }
});

test("createClient surfaces a notice when a task is queued", async () => {
  const runtimeDir = await createTempDir();
  const server = await startServer({
    runtimeDir,
    terminateGraceMs: 50,
    heartbeatTimeoutMs: 5_000,
  });

  const notices: Array<{ type: string; message: string }> = [];
  const client = await createClient({
    runtimeDir,
    heartbeatIntervalMs: 20,
    onNotice(notice) {
      notices.push(notice);
    },
  });

  try {
    const first = await client.run({
      cwd: process.cwd(),
      argv: [
        "bun",
        "-e",
        "setTimeout(() => process.exit(0), 150);",
      ],
      serialMode: "global",
      mergeMode: "by-cwd",
    });

    await client.run({
      cwd: process.cwd(),
      argv: [
        "bun",
        "-e",
        "setTimeout(() => process.exit(0), 10);",
      ],
      serialMode: "global",
      mergeMode: "by-cwd",
    });

    expect(notices).toContainEqual({
      type: "notice",
      kind: "queued",
      message: expect.stringContaining("queued"),
      taskId: "task-2",
      position: 2,
    });
  } finally {
    await client.close();
    await server.stop();
  }
});

test("createClient cleans up socket and bootstrap server on handshake failure", async () => {
  const runtimeDir = await createTempDir();
  const originalConnect = Bun.connect;
  const stopCalls: number[] = [];
  const socketCalls = {
    end: 0,
    close: 0,
    destroy: 0,
  };
  type ConnectionOptions = {
    socket: {
      open?: (socket: never) => void;
      data?: (socket: never, chunk: string | Uint8Array) => void;
      close?: () => void;
      error?: (_socket: never, error: Error) => void;
    };
  };
  let connectionOptions: ConnectionOptions | null = null;

  const fakeSocket = {
    write(chunk: string) {
      const parsed = JSON.parse(chunk);
      if (parsed.type === "hello") {
        queueMicrotask(() => {
          connectionOptions?.socket.data?.(fakeSocket as never, encodeMessage({
            type: "hello-ack",
            serverVersion: "0.1.0",
            protocolVersion: protocolVersion + 1,
          }));
        });
      }
    },
    end() {
      socketCalls.end += 1;
    },
    close() {
      socketCalls.close += 1;
    },
    destroy() {
      socketCalls.destroy += 1;
    },
  } as never;

  Bun.connect = ((options: ConnectionOptions) => {
    connectionOptions = options;
    queueMicrotask(() => {
      options.socket.open?.(fakeSocket);
    });
    return fakeSocket;
  }) as typeof Bun.connect;

  const client = createClient({
    runtimeDir,
    heartbeatIntervalMs: 20,
    startServer: async (options) => {
      const server = await startServer(options);
      const originalStop = server.stop;
      return {
        ...server,
        stop: async () => {
          stopCalls.push(1);
          await originalStop();
        },
      };
    },
  });

  try {
    await expect(client).rejects.toThrow("protocol mismatch");
    expect(stopCalls.length).toBe(1);
    expect(socketCalls.end + socketCalls.close + socketCalls.destroy).toBeGreaterThan(0);
  } finally {
    Bun.connect = originalConnect;
  }
});

test("config defaults runtime directory and merge modes", () => {
  const config = loadConfig({}, "/workspace");

  expect(config.runtimeDir).toBe(join("/workspace", ".cli-lane"));
  expect(config.defaultCwd).toBe("/workspace");
  expect(config.serialMode).toBe("global");
  expect(config.mergeMode).toBe("by-cwd");
});

test("cli run forwards argv after -- and uses the default cwd", async () => {
  const runtimeDir = await createTempDir();
  const stdout = createCapturedWriter();
  const stderr = createCapturedWriter();

  const exitCode = await runCli(
    [
      "run",
      "--",
      "bun",
      "-e",
      "process.stdout.write(process.cwd() + '\\n'); process.stdout.write(Bun.argv.join('|'));",
        "alpha",
        "beta",
      ],
    {
      env: {
        CLI_LANE_RUNTIME_DIR: runtimeDir,
      },
      stdout,
      stderr,
    },
  );

  expect(exitCode).toBe(0);
  expect(stdout.toString()).toContain(process.cwd());
  expect(stdout.toString()).toContain("alpha|beta");
  expect(stderr.toString()).toBe("");
});

test("cli ps prints concise task summaries", async () => {
  const runtimeDir = await createTempDir();
  const bootstrapClient = await createClient({
    runtimeDir,
    heartbeatIntervalMs: 20,
    onMessage() {},
  });

  try {
    const collector = createMessageCollector();
    const streamingClient = await createClient({
      runtimeDir,
      heartbeatIntervalMs: 20,
      onMessage(message) {
        collector.push(message);
      },
    });

    try {
      const accepted = await streamingClient.run({
        cwd: process.cwd(),
        argv: ["bun", "-e", "setInterval(() => {}, 1000);"],
        serialMode: "global",
        mergeMode: "by-cwd",
      });

      await waitForCollectedMessage(
        collector,
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          (message as { type?: string }).type === "task-event" &&
          typeof (message as { event?: { type?: string } }).event === "object" &&
          (message as { event: { type?: string } }).event.type === "started",
      );

      const stdout = createCapturedWriter();
      const stderr = createCapturedWriter();
      const exitCode = await runCli(["ps"], {
        env: {
          CLI_LANE_RUNTIME_DIR: runtimeDir,
        },
        stdout,
        stderr,
      });

      expect(exitCode).toBe(0);
      expect(stdout.toString()).toContain(accepted.taskId);
      expect(stdout.toString()).toContain("running");
      expect(stderr.toString()).toBe("");
    } finally {
      await streamingClient.close();
    }
  } finally {
    await bootstrapClient.close();
  }
});

test("cli cancel requests cancellation for a task", async () => {
  const runtimeDir = await createTempDir();
  const notices: Array<{ type: string; message: string }> = [];
  const collector = createMessageCollector();

  const client = await createClient({
    runtimeDir,
    heartbeatIntervalMs: 20,
    onMessage(message) {
      collector.push(message);
    },
    onNotice(notice) {
      notices.push(notice);
    },
  });

  try {
    const accepted = await client.run({
      cwd: process.cwd(),
      argv: ["bun", "-e", "setInterval(() => {}, 1000);"],
      serialMode: "global",
      mergeMode: "by-cwd",
    });

    await waitForCollectedMessage(
      collector,
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        (message as { type?: string }).type === "task-event" &&
        typeof (message as { event?: { type?: string } }).event === "object" &&
        (message as { event: { type?: string } }).event.type === "started",
    );

    const stdout = createCapturedWriter();
    const stderr = createCapturedWriter();
    const exitCode = await runCli(["cancel", accepted.taskId], {
      env: {
        CLI_LANE_RUNTIME_DIR: runtimeDir,
      },
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stdout.toString()).toContain(`Requested cancellation for task ${accepted.taskId}.`);
    expect(stderr.toString()).toBe("");

    await waitForCollectedMessage(
      collector,
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        (message as { type?: string }).type === "task-event" &&
        typeof (message as { event?: { type?: string } }).event === "object" &&
        (message as { event: { type?: string } }).event.type === "cancelled" &&
        (message as { taskId?: string }).taskId === accepted.taskId,
    );
  } finally {
    await client.close();
  }
});

test("cli run surfaces a cwd mismatch notice for global merges", async () => {
  const runtimeDir = await createTempDir();
  const client = await createClient({
    runtimeDir,
    heartbeatIntervalMs: 20,
  });

  try {
    await client.run({
      cwd: process.cwd(),
      argv: ["bun", "-e", "setTimeout(() => process.exit(0), 120);"],
      serialMode: "global",
      mergeMode: "global",
    });

    const alternateCwd = await createTempDir();
    const stdout = createCapturedWriter();
    const stderr = createCapturedWriter();
    const exitCode = await runCli(
      [
        "run",
        "--cwd",
        alternateCwd,
        "--merge-mode",
        "global",
        "--",
        "bun",
        "-e",
        "process.stdout.write('merged\\n'); setTimeout(() => process.exit(0), 40);",
      ],
      {
        env: {
          CLI_LANE_RUNTIME_DIR: runtimeDir,
        },
        stdout,
        stderr,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.toString()).toContain("your requested cwd was");
  } finally {
    await client.close();
  }
});

test("cli run forwards child --help instead of printing cli help", async () => {
  const runtimeDir = await createTempDir();
  const stdout = createCapturedWriter();
  const stderr = createCapturedWriter();

  const exitCode = await runCli(
    ["run", "--", "bun", "--help"],
    {
      env: {
        CLI_LANE_RUNTIME_DIR: runtimeDir,
      },
      stdout,
      stderr,
    },
  );

  expect(exitCode).toBe(0);
  expect(stdout.toString()).toContain("Bun is a fast JavaScript runtime");
  expect(stderr.toString()).toBe("");
});

test("cli run returns shell-style signal exit codes", async () => {
  const runtimeDir = await createTempDir();
  const stdout = createCapturedWriter();
  const stderr = createCapturedWriter();

  const exitCode = await runCli(
    [
      "run",
      "--",
      "bun",
      "-e",
      "process.kill(process.pid, 'SIGTERM')",
    ],
    {
      env: {
        CLI_LANE_RUNTIME_DIR: runtimeDir,
      },
      stdout,
      stderr,
    },
  );

  expect(exitCode).toBe(143);
  expect(stdout.toString()).toBe("");
  expect(stderr.toString()).toBe("");
});

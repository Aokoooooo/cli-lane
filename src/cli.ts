#!/usr/bin/env bun

import { startServer } from "./server";
import { createClient, type ClientNotice } from "./client";
import { loadConfig, type CliConfig, type MergeMode, type SerialMode } from "./config";
import type { PsTask, ServerToClient, TaskEvent } from "./protocol";
import { runProcess } from "./process-runner";

export type CliIO = {
  stdout?: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
  env?: Record<string, string | undefined>;
  cwd?: string;
};

export async function runCli(args: string[], io: CliIO = {}): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;

  if (args[0] === "__server__") {
    const runtimeDir = args[1];
    if (!runtimeDir) {
      throw new Error("Missing runtime directory for server mode");
    }

    await runCoordinatorServer(runtimeDir);
    return 0;
  }

  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    stdout.write("cli-lane\n");
    return 0;
  }

  const config = loadConfig(io.env ?? process.env, io.cwd ?? process.cwd());
  const [command, ...rest] = args;

  switch (command) {
    case "run":
      return await runCommand(rest, config, stdout, stderr);
    case "ps":
      return await psCommand(config, stdout, stderr);
    case "cancel":
      return await cancelCommand(rest, config, stdout, stderr);
    default:
      throw new Error("Unsupported arguments");
  }
}

if (import.meta.main) {
  try {
    const exitCode = await runCli(process.argv.slice(2));
    process.exit(exitCode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}

async function runCommand(
  args: string[],
  config: CliConfig,
  stdout: { write(chunk: string): unknown },
  stderr: { write(chunk: string): unknown },
): Promise<number> {
  const parsed = parseRunArgs(args, config);
  if ("error" in parsed) {
    throw new Error(parsed.error);
  }

  const bufferedMessages: ServerToClient[] = [];
  let streaming = false;
  let activeTaskId: string | null = null;
  let completionResolved = false;
  let resolveCompletion: ((code: number) => void) | null = null;
  const completion = new Promise<number>((resolve) => {
    resolveCompletion = resolve;
  });

  let client;
  try {
    client = await createClient({
      runtimeDir: config.runtimeDir,
      clientVersion: config.clientVersion,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      bootstrapIfMissing: config.bootstrapIfMissing,
      onNotice(notice) {
        writeLine(stderr, notice.message);
      },
      onMessage(message) {
        if (!streaming) {
          bufferedMessages.push(message);
          return;
        }

        routeRunMessage(message, activeTaskId, stdout, stderr, finish);
      },
    });
    const accepted = await client.run({
      cwd: parsed.cwd,
      argv: parsed.argv,
      serialMode: parsed.serialMode,
      mergeMode: parsed.mergeMode,
    });

    activeTaskId = accepted.taskId;
    streaming = true;
    for (const message of bufferedMessages.splice(0)) {
      routeRunMessage(message, activeTaskId, stdout, stderr, finish);
    }

    return await completion;
  } catch (error) {
    if (client) {
      await client.close();
    }

    if (isBootstrapFailure(error)) {
      return await runDirectCommand(parsed, stdout, stderr);
    }

    throw error;
  } finally {
    if (client) {
      await client.close();
    }
  }

  function finish(code: number): void {
    if (completionResolved) {
      return;
    }

    completionResolved = true;
    resolveCompletion?.(code);
  }
}

async function runDirectCommand(
  parsed: { cwd: string; serialMode: SerialMode; mergeMode: MergeMode; argv: string[] },
  stdout: { write(chunk: string): unknown },
  stderr: { write(chunk: string): unknown },
): Promise<number> {
  const result = await runProcess({
    cwd: parsed.cwd,
    argv: parsed.argv,
    onStdout(chunk) {
      stdout.write(chunk);
    },
    onStderr(chunk) {
      stderr.write(chunk);
    },
  });

  if (result.signal) {
    return signalExitCode(result.signal);
  }

  return result.code ?? 1;
}

async function psCommand(
  config: CliConfig,
  stdout: { write(chunk: string): unknown },
  stderr: { write(chunk: string): unknown },
): Promise<number> {
  const client = await createClient({
    runtimeDir: config.runtimeDir,
    clientVersion: config.clientVersion,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    bootstrapIfMissing: config.bootstrapIfMissing,
  });

  try {
    const result = await client.ps();
    if (result.tasks.length === 0) {
      writeLine(stdout, "No active tasks.");
      return 0;
    }

    for (const task of result.tasks) {
      writeLine(stdout, formatPsTask(task));
    }

    return 0;
  } finally {
    await client.close();
  }
}

async function cancelCommand(
  args: string[],
  config: CliConfig,
  stdout: { write(chunk: string): unknown },
  stderr: { write(chunk: string): unknown },
): Promise<number> {
  const [taskId, ...rest] = args;
  if (!taskId || rest.length > 0) {
    throw new Error("Usage: cli-lane cancel <task-id>");
  }

  const client = await createClient({
    runtimeDir: config.runtimeDir,
    clientVersion: config.clientVersion,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    bootstrapIfMissing: config.bootstrapIfMissing,
  });

  try {
    await client.cancelTask(taskId);
    writeLine(stdout, `Requested cancellation for task ${taskId}.`);
    return 0;
  } finally {
    await client.close();
  }
}

function parseRunArgs(
  args: string[],
  config: CliConfig,
): { cwd: string; serialMode: SerialMode; mergeMode: MergeMode; argv: string[] } | { error: string } {
  let cwd = config.defaultCwd;
  let serialMode = config.serialMode;
  let mergeMode = config.mergeMode;
  let index = 0;

  while (index < args.length && args[index] !== "--") {
    const token = args[index];
    if (token === "--cwd") {
      cwd = requireValue(args, ++index, "--cwd");
      index += 1;
      continue;
    }

    if (token === "--serial-mode") {
      const value = requireValue(args, ++index, "--serial-mode");
      if (value !== "global" && value !== "by-cwd") {
        return { error: "Invalid value for --serial-mode" };
      }
      serialMode = value;
      index += 1;
      continue;
    }

    if (token === "--merge-mode") {
      const value = requireValue(args, ++index, "--merge-mode");
      if (value !== "global" && value !== "by-cwd" && value !== "off") {
        return { error: "Invalid value for --merge-mode" };
      }
      mergeMode = value;
      index += 1;
      continue;
    }

    return { error: `Unsupported arguments: ${token}` };
  }

  if (index >= args.length || args[index] !== "--") {
    return {
      error: "Usage: cli-lane run [--cwd <path>] [--serial-mode global|by-cwd] [--merge-mode by-cwd|global|off] -- <cmd> [args...]",
    };
  }

  const argv = args.slice(index + 1);
  if (argv.length === 0) {
    return {
      error: "Usage: cli-lane run [--cwd <path>] [--serial-mode global|by-cwd] [--merge-mode by-cwd|global|off] -- <cmd> [args...]",
    };
  }

  return {
    cwd,
    serialMode,
    mergeMode,
    argv,
  };
}

function routeRunMessage(
  message: ServerToClient,
  activeTaskId: string | null,
  stdout: { write(chunk: string): unknown },
  stderr: { write(chunk: string): unknown },
  finish: (code: number) => void,
): void {
  if (message.type === "task-event" && message.taskId === activeTaskId) {
    if (message.event.type === "stdout") {
      stdout.write(message.event.data);
      return;
    }

    if (message.event.type === "stderr") {
      stderr.write(message.event.data);
      return;
    }

    if (message.event.type === "exited") {
      finish(exitCodeFromTaskEvent(message.event));
      return;
    }

    if (message.event.type === "cancelled") {
      finish(130);
    }
  }
}

function exitCodeFromTaskEvent(event: Extract<TaskEvent, { type: "exited" }>): number {
  if (event.signal) {
    return signalExitCode(event.signal);
  }

  return event.code ?? 1;
}

function signalExitCode(signal: string): number {
  const signalNumber = SIGNAL_NUMBERS[signal];
  return signalNumber === undefined ? 128 : 128 + signalNumber;
}

const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
};

function formatPsTask(task: PsTask): string {
  const parts = [
    task.taskId,
    task.status,
    `cwd=${task.cwd}`,
    `argv=${formatArgv(task.argv)}`,
    `subscribers=${task.subscriberCount}`,
    `merged=${task.merged ? "yes" : "no"}`,
  ];

  if (task.queuePosition !== undefined) {
    parts.push(`position=${task.queuePosition}`);
  }

  return parts.join(" ");
}

function formatArgv(argv: string[]): string {
  return argv.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
}

function writeLine(writer: { write(chunk: string): unknown }, line: string): void {
  writer.write(`${line}\n`);
}

function requireValue(args: string[], index: number, flag: string): string {
  if (index >= args.length) {
    throw new Error(`Missing value for ${flag}`);
  }

  return args[index];
}

function isBootstrapFailure(error: unknown): boolean {
  return error instanceof Error && (
    error.message.includes("Failed to listen at") ||
    error.message.includes("timed out waiting for coordinator registration") ||
    error.message.includes("coordinator registration not found")
  );
}

async function runCoordinatorServer(runtimeDir: string): Promise<void> {
  const server = await startServer({ runtimeDir, listenHost: "127.0.0.1" });
  const shutdown = async () => {
    await server.stop();
  };

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  await new Promise<void>(() => {
    // Keep the helper process alive until it is stopped from the outside or by idle timeout.
  });
}

#!/usr/bin/env bun

import { createClient, type ClientNotice } from "./client";
import { loadConfig, type CliConfig, type MergeMode, type SerialMode } from "./config";
import type { PsTask, ServerToClient, TaskEvent } from "./protocol";

export type CliIO = {
  stdout?: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
  env?: Record<string, string | undefined>;
  cwd?: string;
};

export async function runCli(args: string[], io: CliIO = {}): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;

  if (args.includes("--help") || args.length === 0) {
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

  const client = await createClient({
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

  try {
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
  } finally {
    await client.close();
  }

  function finish(code: number): void {
    if (completionResolved) {
      return;
    }

    completionResolved = true;
    resolveCompletion?.(code);
  }
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
    return 128;
  }

  return event.code ?? 1;
}

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

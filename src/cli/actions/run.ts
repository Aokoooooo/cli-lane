import { createClient } from "../../client";
import type { CliConfig } from "../../config";
import { runProcess } from "../../process-runner";
import type { ServerToClient } from "../../protocol";
import { exitCodeFromTaskEvent, signalExitCode, writeLine } from "../format";
import { parseRunArgs, type ParsedRunArgs } from "../parse-run-args";

export async function runCommand(
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
  parsed: ParsedRunArgs,
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

function isBootstrapFailure(error: unknown): boolean {
  return error instanceof Error && (
    error.message.includes("Failed to listen at") ||
    error.message.includes("timed out waiting for coordinator registration") ||
    error.message.includes("coordinator registration not found")
  );
}

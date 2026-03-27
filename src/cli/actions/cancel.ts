import { createClient } from "../../client";
import type { CliConfig } from "../../config";
import { writeLine } from "../format";

export async function cancelCommand(
  args: string[],
  config: CliConfig,
  stdout: { write(chunk: string): unknown },
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

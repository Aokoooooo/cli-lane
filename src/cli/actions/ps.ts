import { createClient } from "../../client";
import type { CliConfig } from "../../config";
import { formatPsTask, writeLine } from "../format";

export async function psCommand(
  config: CliConfig,
  stdout: { write(chunk: string): unknown },
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

#!/usr/bin/env bun

export { runCli } from "./cli/run-cli";
export type { CliIO } from "./cli/types";

if (import.meta.main) {
  try {
    const { runCli } = await import("./cli/run-cli");
    const exitCode = await runCli(process.argv.slice(2));
    process.exit(exitCode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}

import path from "node:path";
import { realpath } from "node:fs/promises";

export function normalizeSeparators(input: string): string {
  if (path.sep === "/") {
    return input.replace(/\\+/gu, "/");
  }

  return input.replace(/\//gu, "\\");
}

function stripTrailingSeparators(input: string): string {
  const root = path.parse(input).root;

  if (input === root) {
    return input;
  }

  return input.replace(/[\\/]+$/u, "");
}

export async function normalizeCwd(input: string): Promise<string> {
  const absolute = path.resolve(input);

  let normalized = absolute;

  try {
    normalized = await realpath(absolute);
  } catch {
    normalized = absolute;
  }

  normalized = normalizeSeparators(normalized);
  normalized = stripTrailingSeparators(normalized);

  if (process.platform === "win32") {
    normalized = normalized.toLowerCase();
  }

  return normalized;
}

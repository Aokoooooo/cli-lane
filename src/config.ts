import { join } from 'node:path'

export type SerialMode = 'global' | 'by-cwd'
export type MergeMode = 'global' | 'by-cwd' | 'off'

export type CliConfig = {
  runtimeDir: string
  defaultCwd: string
  serialMode: SerialMode
  mergeMode: MergeMode
  clientVersion: string
  heartbeatIntervalMs: number
  bootstrapIfMissing: boolean
}

const DEFAULT_CLIENT_VERSION = '0.1.0'
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): CliConfig {
  return {
    runtimeDir: env.CLI_LANE_RUNTIME_DIR ?? join(cwd, '.cli-lane'),
    defaultCwd: cwd,
    serialMode: parseSerialMode(env.CLI_LANE_SERIAL_MODE),
    mergeMode: parseMergeMode(env.CLI_LANE_MERGE_MODE),
    clientVersion: env.CLI_LANE_CLIENT_VERSION ?? DEFAULT_CLIENT_VERSION,
    heartbeatIntervalMs: parseNumber(
      env.CLI_LANE_HEARTBEAT_INTERVAL_MS,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
    ),
    bootstrapIfMissing: parseBoolean(env.CLI_LANE_BOOTSTRAP_IF_MISSING, true),
  }
}

function parseSerialMode(value: string | undefined): SerialMode {
  return value === 'by-cwd' ? 'by-cwd' : 'global'
}

function parseMergeMode(value: string | undefined): MergeMode {
  if (value === 'global' || value === 'off') {
    return value
  }

  return 'by-cwd'
}

function parseBoolean(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === undefined) {
    return defaultValue
  }

  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false
  }

  return defaultValue
}

function parseNumber(value: string | undefined, defaultValue: number): number {
  if (value === undefined) {
    return defaultValue
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : defaultValue
}

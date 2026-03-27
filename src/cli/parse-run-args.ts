import type { CliConfig, MergeMode, SerialMode } from '../config'

export type ParsedRunArgs = {
  cwd: string
  serialMode: SerialMode
  mergeMode: MergeMode
  argv: string[]
}

const RUN_USAGE =
  'Usage: cli-lane run [--cwd <path>] [--serial-mode global|by-cwd] [--merge-mode by-cwd|global|off] -- <cmd> [args...]'

export function parseRunArgs(
  args: string[],
  config: CliConfig,
): ParsedRunArgs | { error: string } {
  let cwd = config.defaultCwd
  let serialMode = config.serialMode
  let mergeMode = config.mergeMode
  let index = 0

  while (index < args.length && args[index] !== '--') {
    const token = args[index]
    if (token === '--cwd') {
      cwd = requireValue(args, ++index, '--cwd')
      index += 1
      continue
    }

    if (token === '--serial-mode') {
      const value = requireValue(args, ++index, '--serial-mode')
      if (value !== 'global' && value !== 'by-cwd') {
        return { error: 'Invalid value for --serial-mode' }
      }

      serialMode = value
      index += 1
      continue
    }

    if (token === '--merge-mode') {
      const value = requireValue(args, ++index, '--merge-mode')
      if (value !== 'global' && value !== 'by-cwd' && value !== 'off') {
        return { error: 'Invalid value for --merge-mode' }
      }

      mergeMode = value
      index += 1
      continue
    }

    return { error: `Unsupported arguments: ${token}` }
  }

  if (index >= args.length || args[index] !== '--') {
    return { error: RUN_USAGE }
  }

  const argv = args.slice(index + 1)
  if (argv.length === 0) {
    return { error: RUN_USAGE }
  }

  return {
    cwd,
    serialMode,
    mergeMode,
    argv,
  }
}

function requireValue(args: string[], index: number, flag: string): string {
  if (index >= args.length) {
    throw new Error(`Missing value for ${flag}`)
  }

  return args[index]
}

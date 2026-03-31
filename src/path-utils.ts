import { realpathSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import path from 'node:path'

function normalizeSeparators(input: string): string {
  if (process.platform !== 'win32') {
    return input
  }

  return input.replace(/\/+/gu, '\\')
}

function stripTrailingSeparators(input: string): string {
  const root = path.parse(input).root

  if (input === root) {
    return input
  }

  return input.replace(/[\\/]+$/u, '')
}

export function normalizeCwdForKey(input: string): string {
  let normalized = path.resolve(input)

  try {
    normalized = realpathSync(normalized)
  } catch {
    normalized = path.resolve(input)
  }

  normalized = normalizeSeparators(normalized)
  normalized = stripTrailingSeparators(normalized)

  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase()
  }

  return normalized
}

export async function normalizeCwd(input: string): Promise<string> {
  const absolute = normalizeCwdForKey(input)

  let normalized = absolute

  try {
    normalized = await realpath(absolute)
  } catch {
    normalized = absolute
  }

  return normalizeCwdForKey(normalized)
}

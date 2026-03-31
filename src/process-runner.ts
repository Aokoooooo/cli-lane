import { sleep } from './timing'

export type RunProcessOptions = {
  cwd: string
  argv: string[]
  env?: Record<string, string | undefined>
  output?: {
    isTTY: boolean
    term?: string
    noColor?: boolean
    env?: Record<string, string>
  }
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  signal?: AbortSignal
  graceMs?: number
}

export type RunProcessResult = {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
}

const DEFAULT_GRACE_MS = 3_000

export async function runProcess({
  cwd,
  argv,
  env,
  output,
  onStdout,
  onStderr,
  signal,
  graceMs = DEFAULT_GRACE_MS,
}: RunProcessOptions): Promise<RunProcessResult> {
  if (argv.length === 0) {
    throw new Error('argv must not be empty')
  }

  const proc = Bun.spawn(argv, {
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: buildChildEnv(env, output),
  })

  let stdout = ''
  let stderr = ''

  const stdoutTask = readStream(proc.stdout, (chunk) => {
    stdout += chunk
    onStdout?.(chunk)
  })
  const stderrTask = readStream(proc.stderr, (chunk) => {
    stderr += chunk
    onStderr?.(chunk)
  })

  let rejectTerminationFailure: ((error: unknown) => void) | null = null
  const terminationFailure = new Promise<never>((_, reject) => {
    rejectTerminationFailure = reject
  })
  let terminationTask: Promise<void> | null = null

  const abortHandler = () => {
    if (terminationTask) {
      return
    }

    terminationTask = terminateProcess(proc, graceMs)
    terminationTask.catch((error) => {
      rejectTerminationFailure?.(error)
    })
  }

  if (signal) {
    if (signal.aborted) {
      abortHandler()
    } else {
      signal.addEventListener('abort', abortHandler, { once: true })
    }
  }

  try {
    await Promise.race([proc.exited, terminationFailure])
    await Promise.all([
      stdoutTask,
      stderrTask,
      terminationTask ?? Promise.resolve(),
    ])
  } finally {
    signal?.removeEventListener('abort', abortHandler)
  }

  return {
    code: proc.exitCode,
    signal: proc.signalCode,
    stdout,
    stderr,
  }
}

export async function terminateProcess(
  proc: Bun.Subprocess,
  graceMs: number,
): Promise<void> {
  if (hasExited(proc)) {
    await proc.exited
    return
  }

  try {
    proc.kill()
  } catch (error) {
    if (hasExited(proc)) {
      await proc.exited
      return
    }

    throw error
  }

  const exitedGracefully = await Promise.race([
    proc.exited.then(() => true),
    sleep(graceMs).then(() => false),
  ])

  if (!exitedGracefully && !hasExited(proc)) {
    try {
      proc.kill('SIGKILL')
    } catch (error) {
      if (!hasExited(proc)) {
        throw error
      }
    }
  }

  await proc.exited
}

async function readStream(
  stream: ReadableStream<Uint8Array> | null | undefined,
  onChunk: (chunk: string) => void,
): Promise<void> {
  if (!stream) {
    return
  }

  const reader = stream.getReader()
  const decoder = new TextDecoder()

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        break
      }

      if (!value) {
        continue
      }

      const chunk = decoder.decode(value, { stream: true })

      if (chunk.length > 0) {
        onChunk(chunk)
      }
    }

    const tail = decoder.decode()

    if (tail.length > 0) {
      onChunk(tail)
    }
  } finally {
    reader.releaseLock()
  }
}

function buildChildEnv(
  envOverrides: Record<string, string | undefined> | undefined,
  output:
    | {
        isTTY: boolean
        term?: string
        noColor?: boolean
        env?: Record<string, string>
      }
    | undefined,
): Record<string, string> {
  const env = buildBaseEnv(envOverrides)

  if (output) {
    applyOutputPreferences(env, output)
  }

  return env
}

function buildBaseEnv(
  envOverrides: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {}

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }

  for (const [key, value] of Object.entries(envOverrides ?? {})) {
    if (value === undefined) {
      delete env[key]
      continue
    }

    env[key] = value
  }

  return env
}

function applyOutputPreferences(
  env: Record<string, string>,
  output: {
    isTTY: boolean
    term?: string
    noColor?: boolean
    env?: Record<string, string>
  },
): void {
  for (const key of OUTPUT_ENV_RESET_KEYS) {
    delete env[key]
  }

  if (output.noColor === false) {
    delete env.NO_COLOR
  }

  if (output.term) {
    env.TERM = output.term
  } else if (output.isTTY && !env.TERM) {
    env.TERM = 'xterm-256color'
  }

  for (const [key, value] of Object.entries(output.env ?? {})) {
    env[key] = value
  }

  if (output.noColor) {
    env.NO_COLOR = '1'
    env.CLICOLOR = '0'
    delete env.CLICOLOR_FORCE
    delete env.FORCE_COLOR
    return
  }

  if (env.NO_COLOR !== undefined) {
    return
  }

  if (env.FORCE_COLOR !== undefined) {
    return
  }

  if (env.CLICOLOR === '0') {
    delete env.CLICOLOR_FORCE
    return
  }

  if (output.isTTY) {
    env.FORCE_COLOR = '1'
  }
}

const OUTPUT_ENV_RESET_KEYS = [
  'CLICOLOR',
  'CLICOLOR_FORCE',
  'COLORTERM',
  'FORCE_COLOR',
  'TERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
] as const

function hasExited(proc: Bun.Subprocess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null
}

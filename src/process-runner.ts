export type RunProcessOptions = {
  cwd: string;
  argv: string[];
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
  graceMs?: number;
};

export type RunProcessResult = {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
};

const DEFAULT_GRACE_MS = 100;

export async function runProcess({
  cwd,
  argv,
  onStdout,
  onStderr,
  signal,
  graceMs = DEFAULT_GRACE_MS,
}: RunProcessOptions): Promise<RunProcessResult> {
  if (argv.length === 0) {
    throw new Error("argv must not be empty");
  }

  const proc = Bun.spawn(argv, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let stdout = "";
  let stderr = "";

  const stdoutTask = readStream(proc.stdout, (chunk) => {
    stdout += chunk;
    onStdout?.(chunk);
  });
  const stderrTask = readStream(proc.stderr, (chunk) => {
    stderr += chunk;
    onStderr?.(chunk);
  });

  const abortHandler = () => {
    void terminateProcess(proc, graceMs);
  };

  if (signal) {
    if (signal.aborted) {
      abortHandler();
    } else {
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  try {
    await proc.exited;
    await Promise.all([stdoutTask, stderrTask]);
  } finally {
    signal?.removeEventListener("abort", abortHandler);
  }

  return {
    code: proc.exitCode,
    signal: proc.signalCode,
    stdout,
    stderr,
  };
}

export async function terminateProcess(proc: Bun.Subprocess, graceMs: number): Promise<void> {
  if (hasExited(proc)) {
    await proc.exited;
    return;
  }

  proc.kill();

  const exitedGracefully = await Promise.race([
    proc.exited.then(() => true),
    sleep(graceMs).then(() => false),
  ]);

  if (!exitedGracefully && !hasExited(proc)) {
    proc.kill("SIGKILL");
  }

  await proc.exited;
}

async function readStream(
  stream: ReadableStream<Uint8Array> | null | undefined,
  onChunk: (chunk: string) => void,
): Promise<void> {
  if (!stream) {
    return;
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      const chunk = decoder.decode(value, { stream: true });

      if (chunk.length > 0) {
        onChunk(chunk);
      }
    }

    const tail = decoder.decode();

    if (tail.length > 0) {
      onChunk(tail);
    }
  } finally {
    reader.releaseLock();
  }
}

function hasExited(proc: Bun.Subprocess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

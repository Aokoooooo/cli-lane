import { expect, test, vi } from 'bun:test'
import { runProcess, terminateProcess } from '../../src/process-runner'

test('captures stdout, stderr, callbacks, and exit code', async () => {
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []

  const result = await runProcess({
    cwd: process.cwd(),
    argv: [
      'bun',
      '-e',
      [
        "process.stdout.write('out:1\\n');",
        "process.stderr.write('err:1\\n');",
        "process.stdout.write('out:2\\n');",
        'process.exit(3);',
      ].join(''),
    ],
    onStdout(chunk) {
      stdoutChunks.push(chunk)
    },
    onStderr(chunk) {
      stderrChunks.push(chunk)
    },
  })

  expect(result.code).toBe(3)
  expect(result.signal).toBeNull()
  expect(result.stdout).toBe('out:1\nout:2\n')
  expect(result.stderr).toBe('err:1\n')
  expect(stdoutChunks.join('')).toBe(result.stdout)
  expect(stderrChunks.join('')).toBe(result.stderr)
})

test('preserves inherited terminal env when output preferences are omitted', async () => {
  const result = await runProcess({
    cwd: process.cwd(),
    argv: [
      'bun',
      '-e',
      "process.stdout.write(JSON.stringify({force:process.env.FORCE_COLOR,term:process.env.TERM,no:process.env.NO_COLOR,colorTerm:process.env.COLORTERM}) + '\\n')",
    ],
    env: {
      TERM: 'screen-256color',
      FORCE_COLOR: '2',
      NO_COLOR: '1',
      COLORTERM: 'truecolor',
    },
  })

  expect(result.stdout).toContain('"force":"2"')
  expect(result.stdout).toContain('"term":"screen-256color"')
  expect(result.stdout).toContain('"no":"1"')
  expect(result.stdout).toContain('"colorTerm":"truecolor"')
})

test('defaults child env for non-interactive color-friendly execution', async () => {
  const result = await runProcess({
    cwd: process.cwd(),
    argv: [
      'bun',
      '-e',
      "process.stdout.write(JSON.stringify({force:process.env.FORCE_COLOR,term:process.env.TERM,no:process.env.NO_COLOR,colorTerm:process.env.COLORTERM,termProgram:process.env.TERM_PROGRAM}) + '\\n')",
    ],
    env: {
      NO_COLOR: undefined,
    },
    output: {
      isTTY: true,
      term: 'screen-256color',
      noColor: false,
      env: {
        COLORTERM: 'truecolor',
        TERM_PROGRAM: 'WarpTerminal',
      },
    },
  })

  expect(result.stdout).toContain('"force":"1"')
  expect(result.stdout).toContain('"term":"screen-256color"')
  expect(result.stdout).not.toContain('"no"')
  expect(result.stdout).toContain('"colorTerm":"truecolor"')
  expect(result.stdout).toContain('"termProgram":"WarpTerminal"')
})

test('NO_COLOR overrides force-color style env hints', async () => {
  const result = await runProcess({
    cwd: process.cwd(),
    argv: [
      'bun',
      '-e',
      "process.stdout.write(JSON.stringify({force:process.env.FORCE_COLOR,clickolorForce:process.env.CLICOLOR_FORCE,clickolor:process.env.CLICOLOR,no:process.env.NO_COLOR}) + '\\n')",
    ],
    output: {
      isTTY: true,
      noColor: true,
      env: {
        CLICOLOR_FORCE: '1',
        CLICOLOR: '1',
      },
    },
  })

  expect(result.stdout).toContain('"no":"1"')
  expect(result.stdout).not.toContain('"force"')
  expect(result.stdout).not.toContain('"clickolorForce"')
  expect(result.stdout).toContain('"clickolor":"0"')
})

test('preserves explicit FORCE_COLOR strength from output preferences', async () => {
  const result = await runProcess({
    cwd: process.cwd(),
    argv: [
      'bun',
      '-e',
      "process.stdout.write(JSON.stringify({force:process.env.FORCE_COLOR}) + '\\n')",
    ],
    output: {
      isTTY: true,
      env: {
        FORCE_COLOR: '3',
      },
    },
  })

  expect(result.stdout).toContain('"force":"3"')
})

test('tty output ignores inherited CLICOLOR=0 when it was not explicitly requested', async () => {
  const result = await runProcess({
    cwd: process.cwd(),
    argv: [
      'bun',
      '-e',
      "process.stdout.write(JSON.stringify({force:process.env.FORCE_COLOR,clickolor:process.env.CLICOLOR}) + '\\n')",
    ],
    env: {
      CLICOLOR: '0',
    },
    output: {
      isTTY: true,
      noColor: false,
    },
  })

  expect(result.stdout).toContain('"force":"1"')
  expect(result.stdout).not.toContain('"clickolor":"0"')
})

test('explicit CLICOLOR=0 suppresses default FORCE_COLOR for tty output', async () => {
  const result = await runProcess({
    cwd: process.cwd(),
    argv: [
      'bun',
      '-e',
      "process.stdout.write(JSON.stringify({force:process.env.FORCE_COLOR,clickolor:process.env.CLICOLOR,no:process.env.NO_COLOR}) + '\\n')",
    ],
    env: {
      NO_COLOR: undefined,
    },
    output: {
      isTTY: true,
      env: {
        CLICOLOR: '0',
      },
    },
  })

  expect(result.stdout).not.toContain('"force":"1"')
  expect(result.stdout).toContain('"clickolor":"0"')
  expect(result.stdout).not.toContain('"no":"1"')
})

test('non-tty output preferences clear inherited color forcing env', async () => {
  const result = await runProcess({
    cwd: process.cwd(),
    argv: [
      'bun',
      '-e',
      "process.stdout.write(JSON.stringify({force:process.env.FORCE_COLOR,clickolor:process.env.CLICOLOR,clickolorForce:process.env.CLICOLOR_FORCE,term:process.env.TERM}) + '\\n')",
    ],
    env: {
      FORCE_COLOR: '2',
      CLICOLOR: '1',
      CLICOLOR_FORCE: '1',
      TERM: 'xterm-256color',
    },
    output: {
      isTTY: false,
    },
  })

  expect(result.stdout).not.toContain('"force"')
  expect(result.stdout).not.toContain('"clickolor":"1"')
  expect(result.stdout).not.toContain('"clickolorForce":"1"')
  expect(result.stdout).not.toContain('"term":"xterm-256color"')
})

test('gracefully stops on abort signal', async () => {
  const controller = new AbortController()
  let ready = false

  const runPromise = runProcess({
    cwd: process.cwd(),
    argv: [
      'bun',
      '-e',
      [
        "process.stdout.write('ready\\n');",
        "process.on('SIGTERM', () => {",
        "  process.stdout.write('stopping\\n');",
        '  setTimeout(() => process.exit(0), 25);',
        '});',
        'setInterval(() => {}, 1000);',
      ].join(''),
    ],
    signal: controller.signal,
    onStdout(chunk) {
      if (!ready && chunk.includes('ready')) {
        ready = true
        controller.abort()
      }
    },
  })

  const result = await runPromise

  expect(ready).toBe(true)
  expect(result.code).toBe(0)
  expect(result.signal).toBeNull()
  expect(result.stdout).toContain('ready\n')
  expect(result.stdout).toContain('stopping\n')
})

test('force kills the process after the graceful timeout', async () => {
  const controller = new AbortController()
  let ready = false
  let resolveReady: (() => void) | null = null
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve
  })

  const resultPromise = runProcess({
    cwd: process.cwd(),
    argv: [
      'bun',
      '-e',
      [
        "process.stdout.write('ready\\n');",
        "process.on('SIGTERM', () => {",
        "  process.stdout.write('ignoring\\n');",
        '});',
        'setInterval(() => {}, 1000);',
      ].join(''),
    ],
    signal: controller.signal,
    graceMs: 50,
    onStdout(chunk) {
      if (!ready && chunk.includes('ready')) {
        ready = true
        resolveReady?.()
        controller.abort()
      }
    },
  })

  await readyPromise
  vi.advanceTimersByTime(50)
  const result = await resultPromise

  expect(ready).toBe(true)
  expect(result.stdout).toContain('ready\n')
  expect(result.code).not.toBe(0)
  expect(result.signal).toBe('SIGKILL')
})

test('uses the default graceful timeout when no graceMs is provided', async () => {
  const controller = new AbortController()
  let ready = false

  const resultPromise = runProcess({
    cwd: process.cwd(),
    argv: [
      'bun',
      '-e',
      [
        "process.stdout.write('ready\\n');",
        "process.on('SIGTERM', () => {",
        '  setTimeout(() => process.exit(0), 200);',
        '});',
        'setInterval(() => {}, 1000);',
      ].join(''),
    ],
    signal: controller.signal,
    onStdout(chunk) {
      if (!ready && chunk.includes('ready')) {
        ready = true
        controller.abort()
      }
    },
  })

  const result = await resultPromise

  expect(ready).toBe(true)
  expect(result.code).toBe(0)
  expect(result.signal).toBeNull()
})

test('surfaces terminateProcess kill failures', async () => {
  const expected = new Error('kill failed')
  const proc = {
    exitCode: null,
    signalCode: null,
    exited: new Promise<number | null>(() => {}),
    kill() {
      throw expected
    },
  }

  await expect(
    terminateProcess(proc as unknown as Bun.Subprocess, 10),
  ).rejects.toBe(expected)
})

test('runProcess rejects promptly when termination fails in-flight', async () => {
  const originalSpawn = Bun.spawn
  const controller = new AbortController()
  const expected = new Error('kill failed')

  const fakeProc = {
    stdout: new ReadableStream<Uint8Array>({
      start() {},
    }),
    stderr: new ReadableStream<Uint8Array>({
      start() {},
    }),
    stdin: null,
    exited: new Promise<number | null>(() => {}),
    exitCode: null,
    signalCode: null,
    kill() {
      throw expected
    },
  }

  Bun.spawn = (() => fakeProc) as unknown as typeof Bun.spawn

  try {
    const runPromise = runProcess({
      cwd: process.cwd(),
      argv: ['bun', '-e', 'setInterval(() => {}, 1000)'],
      signal: controller.signal,
    })

    controller.abort()

    await expect(runPromise).rejects.toBe(expected)
  } finally {
    Bun.spawn = originalSpawn
  }
})

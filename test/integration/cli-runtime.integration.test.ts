import { expect, test } from 'bun:test'
import { mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../../src/cli'
import type { ClientNotice } from '../../src/client'
import { createClient } from '../../src/client'
import { loadConfig } from '../../src/config'
import {
  createCapturedWriter,
  createMessageCollector,
  createTempDir,
  waitForCollectedMessage,
} from '../support/client-server'

test('config defaults runtime directory and merge modes', () => {
  const config = loadConfig({}, '/workspace')

  expect(config.runtimeDir).toStartWith(join(tmpdir(), 'cli-lane'))
  expect(config.runtimeDir).not.toContain('/workspace/.cli-lane')
  expect(config.defaultCwd).toBe('/workspace')
  expect(config.serialMode).toBe('global')
  expect(config.mergeMode).toBe('by-cwd')
})

test('config derives distinct default runtime directories per cwd', () => {
  const first = loadConfig({}, '/workspace/project-a')
  const second = loadConfig({}, '/workspace/project-b')

  expect(first.runtimeDir).not.toBe(second.runtimeDir)
  expect(first.runtimeDir).toStartWith(join(tmpdir(), 'cli-lane'))
  expect(second.runtimeDir).toStartWith(join(tmpdir(), 'cli-lane'))
})

test('config derives the same default runtime directory for equivalent cwd strings', () => {
  const first = loadConfig({}, '/workspace/project-a')
  const second = loadConfig({}, '/workspace/project-a/')

  expect(first.runtimeDir).toBe(second.runtimeDir)
})

test('config derives the same default runtime directory for symlinked cwd aliases', async () => {
  const baseDir = await createTempDir()
  const realDir = join(baseDir, 'real')
  const aliasDir = join(baseDir, 'alias')
  await mkdir(realDir)
  await symlink(realDir, aliasDir)

  const first = loadConfig({}, realDir)
  const second = loadConfig({}, aliasDir)

  expect(first.runtimeDir).toBe(second.runtimeDir)
})

test('cli run forwards argv after -- and uses the default cwd', async () => {
  const runtimeDir = await createTempDir()
  const stdout = createCapturedWriter()
  const stderr = createCapturedWriter()

  const exitCode = await runCli(
    [
      'run',
      '--',
      'bun',
      '-e',
      "process.stdout.write(process.cwd() + '\\n'); process.stdout.write(Bun.argv.join('|'));",
      'alpha',
      'beta',
    ],
    {
      env: {
        CLI_LANE_RUNTIME_DIR: runtimeDir,
      },
      stdout,
      stderr,
    },
  )

  expect(exitCode).toBe(0)
  expect(stdout.toString()).toContain(process.cwd())
  expect(stdout.toString()).toContain('alpha|beta')
  expect(stderr.toString()).toBe('')
})

test('cli ps prints concise task summaries', async () => {
  const runtimeDir = await createTempDir()
  const bootstrapClient = await createClient({
    runtimeDir,
    heartbeatIntervalMs: 20,
    onMessage() {},
  })

  try {
    const collector = createMessageCollector()
    const streamingClient = await createClient({
      runtimeDir,
      heartbeatIntervalMs: 20,
      onMessage(message) {
        collector.push(message)
      },
    })

    try {
      const accepted = await streamingClient.run({
        cwd: process.cwd(),
        argv: ['bun', '-e', 'setInterval(() => {}, 1000);'],
        serialMode: 'global',
        mergeMode: 'by-cwd',
      })

      await waitForCollectedMessage(
        collector,
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          (message as { type?: string }).type === 'task-event' &&
          typeof (message as unknown as { event?: { type?: string } }).event ===
            'object' &&
          (message as unknown as { event: { type?: string } }).event.type ===
            'started',
      )

      const stdout = createCapturedWriter()
      const stderr = createCapturedWriter()
      const exitCode = await runCli(['ps'], {
        env: {
          CLI_LANE_RUNTIME_DIR: runtimeDir,
        },
        stdout,
        stderr,
      })

      expect(exitCode).toBe(0)
      expect(stdout.toString()).toContain(accepted.taskId)
      expect(stdout.toString()).toContain('running')
      expect(stderr.toString()).toBe('')
    } finally {
      await streamingClient.close()
    }
  } finally {
    await bootstrapClient.close()
  }
})

test('cli cancel requests cancellation for a task', async () => {
  const runtimeDir = await createTempDir()
  const notices: ClientNotice[] = []
  const collector = createMessageCollector()

  const client = await createClient({
    runtimeDir,
    heartbeatIntervalMs: 20,
    onMessage(message) {
      collector.push(message)
    },
    onNotice(notice) {
      notices.push(notice)
    },
  })

  try {
    const accepted = await client.run({
      cwd: process.cwd(),
      argv: ['bun', '-e', 'setInterval(() => {}, 1000);'],
      serialMode: 'global',
      mergeMode: 'by-cwd',
    })

    await waitForCollectedMessage(
      collector,
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        (message as { type?: string }).type === 'task-event' &&
        typeof (message as unknown as { event?: { type?: string } }).event ===
          'object' &&
        (message as unknown as { event: { type?: string } }).event.type ===
          'started',
    )

    const stdout = createCapturedWriter()
    const stderr = createCapturedWriter()
    const exitCode = await runCli(['cancel', accepted.taskId], {
      env: {
        CLI_LANE_RUNTIME_DIR: runtimeDir,
      },
      stdout,
      stderr,
    })

    expect(exitCode).toBe(0)
    expect(stdout.toString()).toContain(
      `Requested cancellation for task ${accepted.taskId}.`,
    )
    expect(stderr.toString()).toBe('')

    await waitForCollectedMessage(
      collector,
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        (message as { type?: string }).type === 'task-event' &&
        typeof (message as unknown as { event?: { type?: string } }).event ===
          'object' &&
        (message as unknown as { event: { type?: string } }).event.type ===
          'cancelled' &&
        (message as { taskId?: string }).taskId === accepted.taskId,
    )
  } finally {
    await client.close()
  }
})

test('cli run surfaces a cwd mismatch notice for global merges', async () => {
  const runtimeDir = await createTempDir()
  const client = await createClient({
    runtimeDir,
    heartbeatIntervalMs: 20,
  })

  try {
    await client.run({
      cwd: process.cwd(),
      argv: ['bun', '-e', 'setTimeout(() => process.exit(0), 120);'],
      serialMode: 'global',
      mergeMode: 'global',
    })

    const alternateCwd = await createTempDir()
    const stdout = createCapturedWriter()
    const stderr = createCapturedWriter()
    const exitCode = await runCli(
      [
        'run',
        '--cwd',
        alternateCwd,
        '--merge-mode',
        'global',
        '--',
        'bun',
        '-e',
        "process.stdout.write('merged\\n'); setTimeout(() => process.exit(0), 40);",
      ],
      {
        env: {
          CLI_LANE_RUNTIME_DIR: runtimeDir,
        },
        stdout,
        stderr,
      },
    )

    expect(exitCode).toBe(0)
    expect(stderr.toString()).toContain('your requested cwd was')
  } finally {
    await client.close()
  }
})

test('cli run forwards child --help instead of printing cli help', async () => {
  const runtimeDir = await createTempDir()
  const stdout = createCapturedWriter()
  const stderr = createCapturedWriter()

  const exitCode = await runCli(['run', '--', 'bun', '--help'], {
    env: {
      CLI_LANE_RUNTIME_DIR: runtimeDir,
    },
    stdout,
    stderr,
  })

  expect(exitCode).toBe(0)
  expect(stdout.toString()).toContain('Bun is a fast JavaScript runtime')
  expect(stderr.toString()).toBe('')
})

test('cli run returns shell-style signal exit codes', async () => {
  const runtimeDir = await createTempDir()
  const stdout = createCapturedWriter()
  const stderr = createCapturedWriter()

  const exitCode = await runCli(
    ['run', '--', 'bun', '-e', "process.kill(process.pid, 'SIGTERM')"],
    {
      env: {
        CLI_LANE_RUNTIME_DIR: runtimeDir,
      },
      stdout,
      stderr,
    },
  )

  expect(exitCode).toBe(143)
  expect(stdout.toString()).toBe('')
  expect(stderr.toString()).toBe('')
})

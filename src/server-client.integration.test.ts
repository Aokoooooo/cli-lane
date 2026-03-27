import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { createClient } from './client'
import {
  connectToServer,
  createMessageCollector,
  createTempDir,
  nextMessageWithin,
  waitForCollectedMessage,
  waitForMessage,
} from './client-server.test-support'
import { encodeMessage, protocolVersion } from './protocol'
import { readRegistration } from './registry'
import { startServer } from './server'
import { sleep } from './timing'

test('starts the coordinator server and writes registration', async () => {
  const runtimeDir = await createTempDir()
  const server = await startServer({ runtimeDir })

  try {
    expect(server.port).toBeGreaterThan(0)
    expect(server.registration.port).toBe(server.port)
    expect(server.registration.protocolVersion).toBe(protocolVersion)
    expect(await readRegistration(server.registrationPath)).toEqual(
      server.registration,
    )
  } finally {
    await server.stop()
  }
})

test('handshakes hello and heartbeat over TCP', async () => {
  const runtimeDir = await createTempDir()
  const server = await startServer({ runtimeDir })

  try {
    const session = await connectToServer(server.port)

    session.send({
      type: 'hello',
      token: server.registration.token,
      protocolVersion,
      clientVersion: '1.0.0',
    })

    expect(await session.nextMessage()).toEqual({
      type: 'hello-ack',
      serverVersion: expect.any(String),
      protocolVersion,
    })

    session.send({ type: 'heartbeat', sentAt: 123 })

    expect(await session.nextMessage()).toEqual({
      type: 'heartbeat-ack',
      sentAt: 123,
      serverTime: expect.any(Number),
    })
  } finally {
    await server.stop()
  }
})

test('accepts run requests and surfaces active work in ps', async () => {
  const runtimeDir = await createTempDir()
  const server = await startServer({ runtimeDir })

  try {
    const session = await connectToServer(server.port)
    session.send({
      type: 'hello',
      token: server.registration.token,
      protocolVersion,
      clientVersion: '1.0.0',
    })
    await session.nextMessage()

    const requestId = 'req-1'
    session.send({
      type: 'run',
      requestId,
      cwd: process.cwd(),
      argv: ['bun', '-e', 'setTimeout(() => process.exit(0), 50);'],
      serialMode: 'global',
      mergeMode: 'by-cwd',
    })

    const accepted = await session.nextMessage()
    expect(accepted).toEqual({
      type: 'accepted',
      requestId,
      taskId: expect.any(String),
      subscriberId: expect.any(String),
      merged: false,
      executionCwd: process.cwd(),
      requestedCwd: process.cwd(),
    })

    session.send({ type: 'ps', requestId: 'ps-1' })

    const messages = [await session.nextMessage(), await session.nextMessage()]
    expect(messages).toContainEqual({
      type: 'ps-result',
      requestId: 'ps-1',
      tasks: [
        {
          taskId: (accepted as { taskId: string }).taskId,
          status: 'running',
          cwd: process.cwd(),
          argv: ['bun', '-e', 'setTimeout(() => process.exit(0), 50);'],
          subscriberCount: 1,
          merged: false,
        },
      ],
    })
    expect(messages).toContainEqual({
      type: 'task-event',
      taskId: (accepted as { taskId: string }).taskId,
      event: {
        type: 'started',
      },
    })

    await session.close()
  } finally {
    await server.stop()
  }
})

test('cancels a running task through cancel-task', async () => {
  const runtimeDir = await createTempDir()
  const server = await startServer({ runtimeDir, terminateGraceMs: 50 })

  try {
    const session = await connectToServer(server.port)
    session.send({
      type: 'hello',
      token: server.registration.token,
      protocolVersion,
      clientVersion: '1.0.0',
    })
    await session.nextMessage()

    const requestId = 'req-cancel'
    session.send({
      type: 'run',
      requestId,
      cwd: process.cwd(),
      argv: [
        'bun',
        '-e',
        [
          "process.on('SIGTERM', () => process.exit(0));",
          'setInterval(() => {}, 1000);',
        ].join(''),
      ],
      serialMode: 'global',
      mergeMode: 'by-cwd',
    })

    const accepted = await session.nextMessage()
    expect(accepted).toEqual({
      type: 'accepted',
      requestId,
      taskId: expect.any(String),
      subscriberId: expect.any(String),
      merged: false,
      executionCwd: process.cwd(),
      requestedCwd: process.cwd(),
    })

    const started = await session.nextMessage()
    expect(started).toEqual({
      type: 'task-event',
      taskId: (accepted as { taskId: string }).taskId,
      event: {
        type: 'started',
      },
    })

    session.send({
      type: 'cancel-task',
      taskId: (accepted as { taskId: string }).taskId,
    })

    const cancelled = await session.nextMessage()
    expect(cancelled).toEqual({
      type: 'task-event',
      taskId: (accepted as { taskId: string }).taskId,
      event: {
        type: 'cancelled',
      },
    })

    await session.close()
  } finally {
    await server.stop()
  }
})

test('replays buffered output to a late-joining merged subscriber', async () => {
  const runtimeDir = await createTempDir()
  const server = await startServer({ runtimeDir })

  try {
    const sessionA = await connectToServer(server.port)
    sessionA.send({
      type: 'hello',
      token: server.registration.token,
      protocolVersion,
      clientVersion: '1.0.0',
    })
    await nextMessageWithin(sessionA)

    sessionA.send({
      type: 'run',
      requestId: 'req-a',
      cwd: process.cwd(),
      argv: [
        'bun',
        '-e',
        [
          "process.stdout.write('first\\n');",
          "setTimeout(() => process.stderr.write('err\\n'), 30);",
          "setTimeout(() => process.stdout.write('second\\n'), 60);",
          'setTimeout(() => process.exit(0), 90);',
        ].join(''),
      ],
      serialMode: 'global',
      mergeMode: 'by-cwd',
    })

    const acceptedA = await nextMessageWithin(sessionA)
    expect(acceptedA).toEqual({
      type: 'accepted',
      requestId: 'req-a',
      taskId: expect.any(String),
      subscriberId: expect.any(String),
      merged: false,
      executionCwd: process.cwd(),
      requestedCwd: process.cwd(),
    })

    await waitForMessage(
      sessionA,
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        (message as { type?: string }).type === 'task-event' &&
        typeof (message as { event?: { type?: string; data?: string } })
          .event === 'object' &&
        (message as { event: { type?: string; data?: string } }).event.type ===
          'stdout' &&
        (message as { event: { data?: string } }).event.data === 'first\n',
    )

    const sessionB = await connectToServer(server.port)
    sessionB.send({
      type: 'hello',
      token: server.registration.token,
      protocolVersion,
      clientVersion: '1.0.0',
    })
    await nextMessageWithin(sessionB)

    sessionB.send({
      type: 'run',
      requestId: 'req-b',
      cwd: process.cwd(),
      argv: [
        'bun',
        '-e',
        [
          "process.stdout.write('first\\n');",
          "setTimeout(() => process.stderr.write('err\\n'), 30);",
          "setTimeout(() => process.stdout.write('second\\n'), 60);",
          'setTimeout(() => process.exit(0), 90);',
        ].join(''),
      ],
      serialMode: 'global',
      mergeMode: 'by-cwd',
    })

    const acceptedB = await nextMessageWithin(sessionB)
    expect(acceptedB).toEqual({
      type: 'accepted',
      requestId: 'req-b',
      taskId: (acceptedA as { taskId: string }).taskId,
      subscriberId: expect.any(String),
      merged: true,
      executionCwd: process.cwd(),
      requestedCwd: process.cwd(),
    })

    expect(
      await waitForMessage(
        sessionB,
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          (message as { type?: string }).type === 'task-event' &&
          typeof (
            message as {
              event?: { type?: string; data?: string; replay?: boolean }
            }
          ).event === 'object' &&
          (
            message as {
              event: { type?: string; data?: string; replay?: boolean }
            }
          ).event.type === 'stdout' &&
          (message as { event: { data?: string; replay?: boolean } }).event
            .data === 'first\n' &&
          (message as { event: { replay?: boolean } }).event.replay === true,
      ),
    ).toEqual({
      type: 'task-event',
      taskId: (acceptedA as { taskId: string }).taskId,
      event: {
        type: 'stdout',
        data: 'first\n',
        replay: true,
        seq: 1,
        ts: expect.any(Number),
        bytes: Buffer.byteLength('first\n'),
      },
    })

    expect(
      await waitForMessage(
        sessionB,
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          (message as { type?: string }).type === 'task-event' &&
          typeof (message as { event?: { type?: string; data?: string } })
            .event === 'object' &&
          (message as { event: { type?: string; data?: string } }).event
            .type === 'stderr' &&
          (message as { event: { data?: string } }).event.data === 'err\n',
      ),
    ).toEqual({
      type: 'task-event',
      taskId: (acceptedA as { taskId: string }).taskId,
      event: {
        type: 'stderr',
        data: 'err\n',
        replay: false,
        seq: 2,
        ts: expect.any(Number),
        bytes: Buffer.byteLength('err\n'),
      },
    })

    await sessionA.close()
    await sessionB.close()
  } finally {
    await server.stop()
  }
})

test('accepted message exposes execution cwd and requested cwd for global merges', async () => {
  const runtimeDir = await createTempDir()
  const server = await startServer({ runtimeDir })

  try {
    const sessionA = await connectToServer(server.port)
    sessionA.send({
      type: 'hello',
      token: server.registration.token,
      protocolVersion,
      clientVersion: '1.0.0',
    })
    await nextMessageWithin(sessionA)

    sessionA.send({
      type: 'run',
      requestId: 'req-global-a',
      cwd: process.cwd(),
      argv: ['bun', '-e', 'setTimeout(() => process.exit(0), 80);'],
      serialMode: 'global',
      mergeMode: 'global',
    })

    const acceptedA = await nextMessageWithin(sessionA)
    expect(acceptedA).toEqual({
      type: 'accepted',
      requestId: 'req-global-a',
      taskId: expect.any(String),
      subscriberId: expect.any(String),
      merged: false,
      executionCwd: process.cwd(),
      requestedCwd: process.cwd(),
    })

    const otherCwd = `${process.cwd()}/./test/..`
    const sessionB = await connectToServer(server.port)
    sessionB.send({
      type: 'hello',
      token: server.registration.token,
      protocolVersion,
      clientVersion: '1.0.0',
    })
    await nextMessageWithin(sessionB)

    sessionB.send({
      type: 'run',
      requestId: 'req-global-b',
      cwd: otherCwd,
      argv: ['bun', '-e', 'setTimeout(() => process.exit(0), 80);'],
      serialMode: 'global',
      mergeMode: 'global',
    })

    expect(await nextMessageWithin(sessionB)).toEqual({
      type: 'accepted',
      requestId: 'req-global-b',
      taskId: (acceptedA as { taskId: string }).taskId,
      subscriberId: expect.any(String),
      merged: true,
      executionCwd: process.cwd(),
      requestedCwd: otherCwd,
    })

    await sessionA.close()
    await sessionB.close()
  } finally {
    await server.stop()
  }
})

test('ps returns rich task summaries including queue position', async () => {
  const runtimeDir = await createTempDir()
  const server = await startServer({ runtimeDir })

  try {
    const session = await connectToServer(server.port)
    session.send({
      type: 'hello',
      token: server.registration.token,
      protocolVersion,
      clientVersion: '1.0.0',
    })
    await nextMessageWithin(session)

    session.send({
      type: 'run',
      requestId: 'req-running',
      cwd: process.cwd(),
      argv: ['bun', '-e', 'setTimeout(() => process.exit(0), 200);'],
      serialMode: 'global',
      mergeMode: 'by-cwd',
    })
    const runningAccepted = await nextMessageWithin(session)
    await waitForMessage(
      session,
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        (message as { type?: string }).type === 'task-event' &&
        typeof (message as { event?: { type?: string } }).event === 'object' &&
        (message as { event: { type?: string } }).event.type === 'started',
    )

    session.send({
      type: 'run',
      requestId: 'req-queued',
      cwd: process.cwd(),
      argv: ['bun', '-e', 'setTimeout(() => process.exit(0), 50);'],
      serialMode: 'global',
      mergeMode: 'by-cwd',
    })
    const queuedAccepted = await nextMessageWithin(session)
    await waitForMessage(
      session,
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        (message as { type?: string }).type === 'task-event' &&
        typeof (message as { event?: { type?: string; position?: number } })
          .event === 'object' &&
        (message as { event: { type?: string; position?: number } }).event
          .type === 'queued' &&
        (message as { event: { position?: number } }).event.position === 2,
    )

    session.send({ type: 'ps', requestId: 'ps-rich' })

    expect(
      await waitForMessage(
        session,
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          (message as { type?: string }).type === 'ps-result' &&
          (message as { requestId?: string }).requestId === 'ps-rich',
      ),
    ).toEqual({
      type: 'ps-result',
      requestId: 'ps-rich',
      tasks: [
        {
          taskId: (runningAccepted as { taskId: string }).taskId,
          status: 'running',
          cwd: process.cwd(),
          argv: ['bun', '-e', 'setTimeout(() => process.exit(0), 200);'],
          subscriberCount: 1,
          merged: false,
        },
        {
          taskId: (queuedAccepted as { taskId: string }).taskId,
          status: 'queued',
          cwd: process.cwd(),
          argv: ['bun', '-e', 'setTimeout(() => process.exit(0), 50);'],
          subscriberCount: 1,
          merged: false,
          queuePosition: 2,
        },
      ],
    })

    await session.close()
  } finally {
    await server.stop()
  }
})

test('shuts itself down after the idle timeout and cleans registration', async () => {
  const runtimeDir = await createTempDir()
  const server = await startServer({ runtimeDir, idleTimeoutMs: 50 })

  expect(await readRegistration(server.registrationPath)).toEqual(
    server.registration,
  )

  await sleep(150)

  expect(await readRegistration(server.registrationPath)).toBeNull()
  await expect(connectToServer(server.port)).rejects.toThrow()
  await server.stop()
})

test('cancel-subscription detaches only the targeted subscriber', async () => {
  const runtimeDir = await createTempDir()
  const server = await startServer({ runtimeDir, terminateGraceMs: 50 })

  try {
    const sessionA = await connectToServer(server.port)
    sessionA.send({
      type: 'hello',
      token: server.registration.token,
      protocolVersion,
      clientVersion: '1.0.0',
    })
    await nextMessageWithin(sessionA)

    sessionA.send({
      type: 'run',
      requestId: 'req-a',
      cwd: process.cwd(),
      argv: ['bun', '-e', 'setInterval(() => {}, 1000);'],
      serialMode: 'global',
      mergeMode: 'by-cwd',
    })

    const acceptedA = (await nextMessageWithin(sessionA)) as {
      taskId: string
      subscriberId: string
    }

    await waitForMessage(
      sessionA,
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        (message as { type?: string }).type === 'task-event' &&
        typeof (message as { event?: { type?: string } }).event === 'object' &&
        (message as { event: { type?: string } }).event.type === 'started',
    )

    const sessionB = await connectToServer(server.port)
    sessionB.send({
      type: 'hello',
      token: server.registration.token,
      protocolVersion,
      clientVersion: '1.0.0',
    })
    await nextMessageWithin(sessionB)

    sessionB.send({
      type: 'run',
      requestId: 'req-b',
      cwd: process.cwd(),
      argv: ['bun', '-e', 'setInterval(() => {}, 1000);'],
      serialMode: 'global',
      mergeMode: 'by-cwd',
    })

    const acceptedB = (await nextMessageWithin(sessionB)) as {
      taskId: string
      subscriberId: string
    }

    expect(acceptedB.taskId).toBe(acceptedA.taskId)

    sessionB.send({
      type: 'cancel-subscription',
      taskId: acceptedB.taskId,
      subscriberId: acceptedB.subscriberId,
    })

    expect(await nextMessageWithin(sessionB)).toEqual({
      type: 'subscription-detached',
      taskId: acceptedB.taskId,
      subscriberId: acceptedB.subscriberId,
      remainingSubscribers: 1,
      taskStillRunning: true,
    })

    sessionA.send({ type: 'ps', requestId: 'ps-still-running' })
    expect(
      await waitForMessage(
        sessionA,
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          (message as { type?: string }).type === 'ps-result' &&
          (message as { requestId?: string }).requestId === 'ps-still-running',
      ),
    ).toEqual({
      type: 'ps-result',
      requestId: 'ps-still-running',
      tasks: [
        {
          taskId: acceptedA.taskId,
          status: 'running',
          cwd: process.cwd(),
          argv: ['bun', '-e', 'setInterval(() => {}, 1000);'],
          subscriberCount: 1,
          merged: false,
        },
      ],
    })

    sessionA.send({
      type: 'cancel-subscription',
      taskId: acceptedA.taskId,
      subscriberId: acceptedA.subscriberId,
    })

    expect(
      await waitForMessage(
        sessionA,
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          (message as { type?: string }).type === 'task-event' &&
          typeof (message as { event?: { type?: string } }).event ===
            'object' &&
          (message as { event: { type?: string } }).event.type === 'cancelled',
      ),
    ).toEqual({
      type: 'task-event',
      taskId: acceptedA.taskId,
      event: {
        type: 'cancelled',
      },
    })

    await sessionA.close()
    await sessionB.close()
  } finally {
    await server.stop()
  }
})

test('missed heartbeats detach the attached subscriber and auto-cancel the task', async () => {
  const runtimeDir = await createTempDir()
  const server = await startServer({
    runtimeDir,
    terminateGraceMs: 50,
    idleTimeoutMs: 5_000,
    heartbeatTimeoutMs: 80,
  } as Parameters<typeof startServer>[0])

  try {
    const session = await connectToServer(server.port)
    session.send({
      type: 'hello',
      token: server.registration.token,
      protocolVersion,
      clientVersion: '1.0.0',
    })
    await nextMessageWithin(session)

    session.send({
      type: 'run',
      requestId: 'req-heartbeat',
      cwd: process.cwd(),
      argv: ['bun', '-e', 'setInterval(() => {}, 1000);'],
      serialMode: 'global',
      mergeMode: 'by-cwd',
    })

    const accepted = (await nextMessageWithin(session)) as { taskId: string }
    await waitForMessage(
      session,
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        (message as { type?: string }).type === 'task-event' &&
        typeof (message as { event?: { type?: string } }).event === 'object' &&
        (message as { event: { type?: string } }).event.type === 'started',
    )

    session.send({ type: 'heartbeat', sentAt: 1 })
    expect(await nextMessageWithin(session)).toEqual({
      type: 'heartbeat-ack',
      sentAt: 1,
      serverTime: expect.any(Number),
    })

    expect(
      await waitForMessage(
        session,
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          (message as { type?: string }).type === 'task-event' &&
          typeof (message as { event?: { type?: string } }).event ===
            'object' &&
          (message as { event: { type?: string } }).event.type === 'cancelled',
        1_000,
      ),
    ).toEqual({
      type: 'task-event',
      taskId: accepted.taskId,
      event: {
        type: 'cancelled',
      },
    })
  } finally {
    await server.stop()
  }
})

test('disconnecting during run normalization does not leave a zombie subscriber', async () => {
  const runtimeDir = await createTempDir()
  const server = await startServer({ runtimeDir, idleTimeoutMs: 5_000 })

  try {
    const session = await connectToServer(server.port)
    session.send({
      type: 'hello',
      token: server.registration.token,
      protocolVersion,
      clientVersion: '1.0.0',
    })
    await nextMessageWithin(session)

    session.send({
      type: 'run',
      requestId: 'req-zombie',
      cwd: join(process.cwd(), '.', 'test', '..'),
      argv: ['bun', '-e', 'setTimeout(() => process.exit(0), 250);'],
      serialMode: 'global',
      mergeMode: 'by-cwd',
    })

    await session.close()

    const inspector = await connectToServer(server.port)
    inspector.send({
      type: 'hello',
      token: server.registration.token,
      protocolVersion,
      clientVersion: '1.0.0',
    })
    await nextMessageWithin(inspector)

    await sleep(50)

    inspector.send({ type: 'ps', requestId: 'ps-zombie' })
    expect(await nextMessageWithin(inspector)).toEqual({
      type: 'ps-result',
      requestId: 'ps-zombie',
      tasks: [],
    })

    await inspector.close()
  } finally {
    await server.stop()
  }
})

test('unauthenticated connections time out and do not block idle shutdown', async () => {
  const runtimeDir = await createTempDir()
  const server = await startServer({
    runtimeDir,
    idleTimeoutMs: 50,
    heartbeatTimeoutMs: 500,
  })

  const session = await connectToServer(server.port)

  await expect(session.closed).resolves.toBeUndefined()
  await sleep(100)

  expect(await readRegistration(server.registrationPath)).toBeNull()
  await expect(connectToServer(server.port)).rejects.toThrow()
  await server.stop()
})

test('createClient can bootstrap a coordinator and keep it alive with heartbeats', async () => {
  const runtimeDir = await createTempDir()
  const client = await createClient({
    runtimeDir,
    heartbeatIntervalMs: 20,
  })

  try {
    await sleep(120)

    const ps = await client.ps()
    expect(ps).toEqual({
      type: 'ps-result',
      requestId: expect.any(String),
      tasks: [],
    })
  } finally {
    await client.close()
  }
})

test('createClient can run commands and detach subscriptions explicitly', async () => {
  const runtimeDir = await createTempDir()
  const server = await startServer({
    runtimeDir,
    terminateGraceMs: 50,
    heartbeatTimeoutMs: 5_000,
  })

  const collector = createMessageCollector()
  const client = await createClient({
    runtimeDir,
    heartbeatIntervalMs: 20,
    onMessage(message) {
      collector.push(message)
    },
  })

  try {
    const accepted = await client.run({
      cwd: process.cwd(),
      argv: [
        'bun',
        '-e',
        [
          "process.stdout.write('hello\\n');",
          'setInterval(() => {}, 1000);',
        ].join(''),
      ],
      serialMode: 'global',
      mergeMode: 'by-cwd',
    })

    expect(accepted).toEqual({
      type: 'accepted',
      requestId: expect.any(String),
      taskId: expect.any(String),
      subscriberId: expect.any(String),
      merged: false,
      executionCwd: process.cwd(),
      requestedCwd: process.cwd(),
    })

    expect(
      await waitForCollectedMessage(
        collector,
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          (message as { type?: string }).type === 'task-event' &&
          (message as { event?: { type?: string } }).event?.type === 'stdout',
      ),
    ).toEqual({
      type: 'task-event',
      taskId: accepted.taskId,
      event: {
        type: 'stdout',
        data: 'hello\n',
        seq: 1,
        ts: expect.any(Number),
        bytes: 6,
        replay: false,
      },
    })

    const detachedPromise = waitForCollectedMessage(
      collector,
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        (message as { type?: string }).type === 'subscription-detached' &&
        (message as { taskId?: string }).taskId === accepted.taskId,
    )

    const detached = await client.cancelSubscription(
      accepted.taskId,
      accepted.subscriberId,
    )
    expect(detached).toEqual({
      type: 'subscription-detached',
      taskId: accepted.taskId,
      subscriberId: accepted.subscriberId,
      remainingSubscribers: 0,
      taskStillRunning: false,
    })
    expect(await detachedPromise).toEqual(detached)

    const cancelAccepted = await client.run({
      cwd: process.cwd(),
      argv: ['bun', '-e', 'setInterval(() => {}, 1000);'],
      serialMode: 'global',
      mergeMode: 'by-cwd',
    })

    const cancelledPromise = waitForCollectedMessage(
      collector,
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        (message as { type?: string }).type === 'task-event' &&
        typeof (message as { event?: { type?: string } }).event === 'object' &&
        (message as { event: { type?: string } }).event.type === 'cancelled' &&
        (message as { taskId?: string }).taskId === cancelAccepted.taskId,
    )

    await client.cancelTask(cancelAccepted.taskId)
    expect(await cancelledPromise).toEqual({
      type: 'task-event',
      taskId: cancelAccepted.taskId,
      event: {
        type: 'cancelled',
      },
    })
  } finally {
    await client.close()
    await server.stop()
  }
})

test('createClient surfaces a notice when explicit detach leaves the task running', async () => {
  const runtimeDir = await createTempDir()
  const server = await startServer({
    runtimeDir,
    terminateGraceMs: 50,
    heartbeatTimeoutMs: 5_000,
  })

  const notices: Array<{ type: string; message: string }> = []
  const client = await createClient({
    runtimeDir,
    heartbeatIntervalMs: 20,
    onNotice(notice) {
      notices.push(notice)
    },
  })

  try {
    await client.run({
      cwd: process.cwd(),
      argv: ['bun', '-e', 'setInterval(() => {}, 1000);'],
      serialMode: 'global',
      mergeMode: 'by-cwd',
    })

    const merged = await client.run({
      cwd: process.cwd(),
      argv: ['bun', '-e', 'setInterval(() => {}, 1000);'],
      serialMode: 'global',
      mergeMode: 'by-cwd',
    })

    const detached = await client.cancelSubscription(
      merged.taskId,
      merged.subscriberId,
    )
    expect(detached.taskStillRunning).toBe(true)
    expect(detached.remainingSubscribers).toBe(1)
    expect(notices).toContainEqual({
      type: 'notice',
      kind: 'subscription-detached',
      message: expect.stringContaining('Detached from task'),
      taskId: merged.taskId,
      subscriberId: merged.subscriberId,
      remainingSubscribers: 1,
      taskStillRunning: true,
    })
  } finally {
    await client.close()
    await server.stop()
  }
})

test('createClient surfaces a notice for global merge cwd mismatch', async () => {
  const runtimeDir = await createTempDir()
  const alternateCwd = await createTempDir()
  const server = await startServer({
    runtimeDir,
    terminateGraceMs: 50,
    heartbeatTimeoutMs: 5_000,
  })

  const notices: Array<{ type: string; message: string }> = []
  const client = await createClient({
    runtimeDir,
    heartbeatIntervalMs: 20,
    onNotice(notice) {
      notices.push(notice)
    },
  })

  try {
    const first = await client.run({
      cwd: process.cwd(),
      argv: ['bun', '-e', 'setTimeout(() => process.exit(0), 120);'],
      serialMode: 'global',
      mergeMode: 'global',
    })

    await client.run({
      cwd: alternateCwd,
      argv: ['bun', '-e', 'setTimeout(() => process.exit(0), 120);'],
      serialMode: 'global',
      mergeMode: 'global',
    })

    expect(notices).toContainEqual({
      type: 'notice',
      kind: 'cwd-mismatch',
      message: expect.stringContaining('executing in'),
      taskId: first.taskId,
      executionCwd: process.cwd(),
      requestedCwd: alternateCwd,
    })
  } finally {
    await client.close()
    await server.stop()
  }
})

test('createClient surfaces a notice when a task is queued', async () => {
  const runtimeDir = await createTempDir()
  const server = await startServer({
    runtimeDir,
    terminateGraceMs: 50,
    heartbeatTimeoutMs: 5_000,
  })

  const notices: Array<{ type: string; message: string }> = []
  const client = await createClient({
    runtimeDir,
    heartbeatIntervalMs: 20,
    onNotice(notice) {
      notices.push(notice)
    },
  })

  try {
    await client.run({
      cwd: process.cwd(),
      argv: ['bun', '-e', 'setTimeout(() => process.exit(0), 150);'],
      serialMode: 'global',
      mergeMode: 'by-cwd',
    })

    await client.run({
      cwd: process.cwd(),
      argv: ['bun', '-e', 'setTimeout(() => process.exit(0), 10);'],
      serialMode: 'global',
      mergeMode: 'by-cwd',
    })

    expect(notices).toContainEqual({
      type: 'notice',
      kind: 'queued',
      message: expect.stringContaining('queued'),
      taskId: 'task-2',
      position: 2,
    })
  } finally {
    await client.close()
    await server.stop()
  }
})

test('createClient cleans up socket and bootstrap server on handshake failure', async () => {
  const runtimeDir = await createTempDir()
  const originalConnect = Bun.connect
  const stopCalls: number[] = []
  const socketCalls = {
    end: 0,
    close: 0,
    destroy: 0,
  }
  type ConnectionOptions = {
    socket: {
      open?: (socket: never) => void
      data?: (socket: never, chunk: string | Uint8Array) => void
      close?: () => void
      error?: (_socket: never, error: Error) => void
    }
  }
  let connectionOptions: ConnectionOptions | null = null

  const fakeSocket = {
    write(chunk: string) {
      const parsed = JSON.parse(chunk)
      if (parsed.type === 'hello') {
        queueMicrotask(() => {
          connectionOptions?.socket.data?.(
            fakeSocket as never,
            encodeMessage({
              type: 'hello-ack',
              serverVersion: '0.1.0',
              protocolVersion: protocolVersion + 1,
            }),
          )
        })
      }
    },
    end() {
      socketCalls.end += 1
    },
    close() {
      socketCalls.close += 1
    },
    destroy() {
      socketCalls.destroy += 1
    },
  } as never

  Bun.connect = ((options: ConnectionOptions) => {
    connectionOptions = options
    queueMicrotask(() => {
      options.socket.open?.(fakeSocket)
    })
    return fakeSocket
  }) as typeof Bun.connect

  const client = createClient({
    runtimeDir,
    heartbeatIntervalMs: 20,
    startServer: async (options) => {
      const server = await startServer(options)
      const originalStop = server.stop
      return {
        ...server,
        stop: async () => {
          stopCalls.push(1)
          await originalStop()
        },
      }
    },
  })

  try {
    await expect(client).rejects.toThrow('protocol mismatch')
    expect(stopCalls.length).toBe(1)
    expect(
      socketCalls.end + socketCalls.close + socketCalls.destroy,
    ).toBeGreaterThan(0)
  } finally {
    Bun.connect = originalConnect
  }
})

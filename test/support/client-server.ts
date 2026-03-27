import { afterEach, vi } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeMessageChunk, encodeMessage } from '../../src/protocol'
import { withTimeout } from '../../src/timing'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

export async function createTempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'cli-lane-server-test-'))
  tempDirs.push(dir)
  return dir
}

export type ServerSession = {
  socket: Socket
  send: (message: unknown) => void
  nextMessage: () => Promise<unknown>
  close: () => Promise<void>
  closed: Promise<void>
}

export type MessageCollector = {
  push: (message: unknown) => void
  nextMessage: () => Promise<unknown>
}

export async function nextMessageWithin(
  session: ServerSession,
  timeoutMs = 1_000,
): Promise<unknown> {
  return await withTimeout(session.nextMessage(), timeoutMs)
}

export async function waitForMessage(
  session: ServerSession,
  predicate: (message: unknown) => boolean,
  timeoutMs = 1_500,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const message = await nextMessageWithin(
      session,
      Math.max(1, deadline - Date.now()),
    )
    if (predicate(message)) {
      return message
    }
  }

  throw new Error(`timed out after ${timeoutMs}ms`)
}

export async function waitForCollectedMessage(
  collector: MessageCollector,
  predicate: (message: unknown) => boolean,
  timeoutMs = 1_500,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const message = await withTimeout(collector.nextMessage(), timeoutMs)
    if (predicate(message)) {
      return message
    }
  }

  throw new Error(`timed out after ${timeoutMs}ms`)
}

export async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs

  while (performance.now() < deadline) {
    if (await condition()) {
      return
    }

    await Promise.resolve()
  }

  throw new Error(`timed out after ${timeoutMs}ms`)
}

export function createMessageCollector(): MessageCollector {
  const queue: unknown[] = []
  const waiters: Array<(message: unknown) => void> = []

  return {
    push(message) {
      const next = waiters.shift()
      if (next) {
        next(message)
      } else {
        queue.push(message)
      }
    },
    nextMessage() {
      const queued = queue.shift()
      if (queued !== undefined) {
        return Promise.resolve(queued)
      }

      return new Promise<unknown>((resolve) => {
        waiters.push(resolve)
      })
    },
  }
}

export function createCapturedWriter() {
  const chunks: string[] = []

  return {
    write(chunk: string) {
      chunks.push(chunk)
    },
    toString() {
      return chunks.join('')
    },
  }
}

export async function connectToServer(port: number): Promise<ServerSession> {
  const socket = createConnection({ host: '127.0.0.1', port })
  const queue: unknown[] = []
  const waiters: Array<(message: unknown) => void> = []
  let buffer = ''
  const closed = new Promise<void>((resolve) => {
    socket.once('close', () => resolve())
  })

  socket.setEncoding('utf8')

  socket.on('data', (chunk: string) => {
    buffer += chunk
    const decoded = decodeMessageChunk(buffer)
    buffer = decoded.remainder

    for (const message of decoded.messages) {
      const next = waiters.shift()
      if (next) {
        next(message)
      } else {
        queue.push(message)
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })

  return {
    socket,
    send(message) {
      socket.write(encodeMessage(message as never))
    },
    nextMessage() {
      const queued = queue.shift()
      if (queued !== undefined) {
        return Promise.resolve(queued)
      }

      return new Promise<unknown>((resolve) => {
        waiters.push(resolve)
      })
    },
    close() {
      return new Promise<void>((resolve) => {
        socket.once('close', () => resolve())
        socket.end()
        setTimeout(() => {
          if (!socket.destroyed) {
            socket.destroy()
          }
        }, 25)
      })
    },
    closed,
  }
}

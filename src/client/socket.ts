import {
  type ClientToServer,
  decodeMessageChunk,
  encodeMessage,
  type ServerToClient,
} from '../protocol'
import { withTimeout } from '../timing'
import { emitNotice } from './notices'
import type { ConnectionState } from './types'

export async function openSocket(
  port: number,
  bootstrappedServer: ConnectionState['bootstrappedServer'],
  registration: ConnectionState['registration'],
): Promise<ConnectionState> {
  let resolveClose: (() => void) | null = null
  const closePromise = new Promise<void>((resolve) => {
    resolveClose = resolve
  })

  const state: ConnectionState = {
    socket: null,
    buffer: '',
    history: [],
    waiters: [],
    heartbeatTimer: null,
    closed: false,
    bootstrappedServer,
    registration,
    onMessage: undefined,
    onNotice: undefined,
    closePromise,
    resolveClose,
  }

  await new Promise<void>((resolve, reject) => {
    const socket = (Bun as any).connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        open(clientSocket: any) {
          state.socket = clientSocket
          resolve()
        },
        data(_clientSocket: any, chunk: string | Uint8Array) {
          if (state.closed) {
            return
          }

          state.buffer += toUtf8(chunk)
          const decoded = decodeMessageChunk(state.buffer)
          state.buffer = decoded.remainder

          for (const message of decoded.messages as ServerToClient[]) {
            handleInboundMessage(state, message)
          }
        },
        close() {
          state.closed = true
          clearHeartbeatTimer(state)
          rejectWaiters(state, new Error('client disconnected'))
          state.resolveClose?.()
        },
        error(_clientSocket: any, error: Error) {
          reject(error)
        },
      },
    })

    if (socket && !state.socket) {
      state.socket = socket
    }
  })

  return state
}

export function sendMessage(
  state: ConnectionState,
  message: ClientToServer,
): void {
  if (state.closed || !state.socket) {
    throw new Error('client is closed')
  }

  state.socket.write(encodeMessage(message))
}

export async function waitForMessage<T extends ServerToClient>(
  state: ConnectionState,
  predicate: (message: ServerToClient) => message is T,
  timeoutMs = 2_000,
): Promise<T> {
  if (state.closed) {
    throw new Error('client is closed')
  }

  for (const message of state.history) {
    if (predicate(message)) {
      return message
    }
  }

  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const index = state.waiters.findIndex(
        (entry) => entry.timeout === timeout,
      )
      if (index !== -1) {
        state.waiters.splice(index, 1)
      }
      reject(new Error(`timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    state.waiters.push({
      predicate,
      resolve,
      reject,
      timeout,
    })
  })
}

export async function closeClient(
  state: ConnectionState,
  options: { stopBootstrappedServer?: boolean } = {},
): Promise<void> {
  if (state.closed) {
    await state.closePromise
    return
  }

  state.closed = true
  clearHeartbeatTimer(state)
  rejectWaiters(state, new Error('client is closed'))

  const socket = state.socket
  socket?.end?.()
  socket?.close?.()
  socket?.destroy?.()

  await withTimeout(state.closePromise, 50).catch(() => {})

  if (options.stopBootstrappedServer !== false && state.bootstrappedServer) {
    await state.bootstrappedServer.stop()
  }
}

export function clearHeartbeatTimer(state: ConnectionState): void {
  if (state.heartbeatTimer === null) {
    return
  }

  clearInterval(state.heartbeatTimer)
  state.heartbeatTimer = null
}

function handleInboundMessage(
  state: ConnectionState,
  message: ServerToClient,
): void {
  state.history.push(message)
  state.onMessage?.(message)
  emitNotice(state.onNotice, message)

  for (const waiter of [...state.waiters]) {
    if (!waiter.predicate(message)) {
      continue
    }

    clearTimeout(waiter.timeout)
    state.waiters.splice(state.waiters.indexOf(waiter), 1)
    waiter.resolve(message)
  }
}

function rejectWaiters(state: ConnectionState, error: Error): void {
  for (const waiter of state.waiters.splice(0)) {
    clearTimeout(waiter.timeout)
    waiter.reject(error)
  }
}

function toUtf8(chunk: string | Uint8Array): string {
  if (typeof chunk === 'string') {
    return chunk
  }

  return new TextDecoder().decode(chunk)
}

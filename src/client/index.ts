import { randomUUID } from 'node:crypto'
import type {
  AcceptedMessage,
  ClientToServer,
  PsResultMessage,
  ServerToClient,
  SubscriptionDetachedMessage,
} from '../protocol'
import { startServer } from '../server'
import { connectOrBootstrap } from './bootstrap'

export type { ClientNotice } from './notices'

import {
  clearHeartbeatTimer,
  closeClient,
  sendMessage,
  waitForMessage,
} from './socket'

export type { Client, ClientOptions } from './types'

import type { Client, ClientOptions, ConnectionState } from './types'

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000
const DEFAULT_BOOTSTRAP_IF_MISSING = true

export async function createClient(options: ClientOptions): Promise<Client> {
  const runtimeDir = options.runtimeDir
  const clientVersion = options.clientVersion ?? '0.1.0'
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
  const bootstrapIfMissing =
    options.bootstrapIfMissing ?? DEFAULT_BOOTSTRAP_IF_MISSING
  const startCoordinator = options.startServer ?? startServer

  const state = await connectOrBootstrap({
    runtimeDir,
    bootstrapIfMissing,
    startCoordinator,
    clientVersion,
    onMessage: options.onMessage,
    onNotice: options.onNotice,
  })

  startHeartbeat(state, heartbeatIntervalMs)

  return {
    run(request) {
      return sendRequest<AcceptedMessage>(state, {
        type: 'run',
        requestId: randomUUID(),
        cwd: request.cwd,
        argv: [...request.argv],
        serialMode: request.serialMode ?? 'global',
        mergeMode: request.mergeMode ?? 'by-cwd',
      })
    },
    ps() {
      return sendRequest<PsResultMessage>(state, {
        type: 'ps',
        requestId: randomUUID(),
      })
    },
    async cancelTask(taskId: string) {
      sendMessage(state, {
        type: 'cancel-task',
        taskId,
      })
    },
    cancelSubscription(taskId: string, subscriberId: string) {
      sendMessage(state, {
        type: 'cancel-subscription',
        taskId,
        subscriberId,
      })

      return waitForMessage<SubscriptionDetachedMessage>(
        state,
        (message): message is SubscriptionDetachedMessage =>
          message.type === 'subscription-detached' &&
          message.taskId === taskId &&
          message.subscriberId === subscriberId,
      )
    },
    close() {
      return closeClient(state)
    },
  }
}

function startHeartbeat(
  state: ConnectionState,
  heartbeatIntervalMs: number,
): void {
  clearHeartbeatTimer(state)
  state.heartbeatTimer = setInterval(() => {
    if (state.closed) {
      clearHeartbeatTimer(state)
      return
    }

    sendMessage(state, {
      type: 'heartbeat',
      sentAt: Date.now(),
    })
  }, heartbeatIntervalMs)
}

async function sendRequest<T extends ServerToClient>(
  state: ConnectionState,
  message: ClientToServer,
): Promise<T> {
  sendMessage(state, message)

  if (message.type === 'run') {
    return (await waitForMessage(
      state,
      (candidate): candidate is Extract<T, AcceptedMessage> =>
        candidate.type === 'accepted' &&
        candidate.requestId === message.requestId,
    )) as T
  }

  if (message.type === 'ps') {
    return (await waitForMessage(
      state,
      (candidate): candidate is Extract<T, PsResultMessage> =>
        candidate.type === 'ps-result' &&
        candidate.requestId === message.requestId,
    )) as T
  }

  throw new Error('unsupported request type')
}

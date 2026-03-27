import type {
  AcceptedMessage,
  PsResultMessage,
  RunMessage,
  ServerToClient,
  SubscriptionDetachedMessage,
} from '../protocol'
import type { Registration } from '../registry'
import type { CoordinatorServer, StartServerOptions } from '../server'
import type { ClientNotice } from './notices'

export type ClientOptions = {
  runtimeDir: string
  clientVersion?: string
  heartbeatIntervalMs?: number
  bootstrapIfMissing?: boolean
  onMessage?: (message: ServerToClient) => void
  onNotice?: (notice: ClientNotice) => void
  startServer?: (options: StartServerOptions) => Promise<CoordinatorServer>
}

export type Client = {
  run(request: Omit<RunMessage, 'type' | 'requestId'>): Promise<AcceptedMessage>
  ps(): Promise<PsResultMessage>
  cancelTask(taskId: string): Promise<void>
  cancelSubscription(
    taskId: string,
    subscriberId: string,
  ): Promise<SubscriptionDetachedMessage>
  close(): Promise<void>
}

export type Waiter<T extends ServerToClient> = {
  predicate: (message: ServerToClient) => message is T
  resolve: (message: T) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

export type ConnectionState = {
  socket: any
  buffer: string
  history: ServerToClient[]
  waiters: Array<Waiter<any>>
  heartbeatTimer: ReturnType<typeof setInterval> | null
  closed: boolean
  bootstrappedServer: CoordinatorServer | null
  registration: Registration
  onMessage?: (message: ServerToClient) => void
  onNotice?: (notice: ClientNotice) => void
  closePromise: Promise<void>
  resolveClose: (() => void) | null
}

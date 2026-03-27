import { join } from 'node:path'
import { protocolVersion, type ServerToClient } from '../protocol'
import { type Registration, readRegistration } from '../registry'
import type { CoordinatorServer, StartServerOptions } from '../server'
import { sleep } from '../timing'
import type { ClientNotice } from './notices'
import { closeClient, openSocket, sendMessage, waitForMessage } from './socket'
import type { ConnectionState } from './types'

export async function connectOrBootstrap(options: {
  runtimeDir: string
  bootstrapIfMissing: boolean
  startCoordinator: (options: StartServerOptions) => Promise<CoordinatorServer>
  clientVersion: string
  onMessage?: (message: ServerToClient) => void
  onNotice?: (notice: ClientNotice) => void
}): Promise<ConnectionState> {
  const registrationPath = join(options.runtimeDir, 'registration.json')
  const existing = await readRegistration(registrationPath)

  if (existing) {
    try {
      return await connectToRegistration(
        existing,
        null,
        options.clientVersion,
        options.onMessage,
        options.onNotice,
      )
    } catch (error) {
      if (!options.bootstrapIfMissing) {
        throw error
      }
    }
  } else if (!options.bootstrapIfMissing) {
    throw new Error('coordinator registration not found')
  }

  const bootstrappedServer = await startCoordinatorForRuntime(options)
  try {
    return await connectToRegistration(
      bootstrappedServer.registration,
      bootstrappedServer,
      options.clientVersion,
      options.onMessage,
      options.onNotice,
    )
  } catch (error) {
    await bootstrappedServer.stop()
    throw error
  }
}

export function isListenFailure(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Failed to listen at')
}

async function startCoordinatorForRuntime(options: {
  runtimeDir: string
  startCoordinator: (options: StartServerOptions) => Promise<CoordinatorServer>
}): Promise<CoordinatorServer> {
  try {
    return await options.startCoordinator({ runtimeDir: options.runtimeDir })
  } catch (error) {
    if (!isListenFailure(error)) {
      throw error
    }
  }

  return await startCoordinatorInHelperProcess(options.runtimeDir)
}

async function connectToRegistration(
  registration: Registration,
  bootstrappedServer: CoordinatorServer | null,
  clientVersion: string,
  onMessage?: (message: ServerToClient) => void,
  onNotice?: (notice: ClientNotice) => void,
): Promise<ConnectionState> {
  const state = await openSocket(
    registration.port,
    bootstrappedServer,
    registration,
  )
  try {
    state.onMessage = onMessage
    state.onNotice = onNotice

    sendMessage(state, {
      type: 'hello',
      token: registration.token,
      protocolVersion,
      clientVersion,
    })

    const hello = await waitForMessage(
      state,
      (message): message is Extract<ServerToClient, { type: 'hello-ack' }> =>
        message.type === 'hello-ack',
    )

    if (hello.protocolVersion !== protocolVersion) {
      throw new Error('protocol mismatch')
    }

    return state
  } catch (error) {
    await closeClient(state, { stopBootstrappedServer: false })
    throw error
  }
}

async function startCoordinatorInHelperProcess(
  runtimeDir: string,
): Promise<CoordinatorServer> {
  const helperScript = join(process.cwd(), 'src', 'cli.ts')
  const child = Bun.spawn(
    ['bun', 'run', helperScript, '__server__', runtimeDir],
    {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    },
  )

  const registrationPath = join(runtimeDir, 'registration.json')
  const registration = await waitForRegistration(registrationPath)

  return {
    port: registration.port,
    registrationPath,
    registration,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return
      }

      child.kill()

      const exitedGracefully = await Promise.race([
        child.exited.then(() => true),
        sleep(3_000).then(() => false),
      ])

      if (
        !exitedGracefully &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        child.kill('SIGKILL')
      }

      await child.exited
    },
  }
}

async function waitForRegistration(
  filePath: string,
  timeoutMs = 5_000,
): Promise<Registration> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const registration = await readRegistration(filePath)
    if (registration) {
      return registration
    }

    await sleep(50)
  }

  throw new Error('timed out waiting for coordinator registration')
}

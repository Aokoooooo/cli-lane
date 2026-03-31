import { afterEach, expect, test, vi } from 'bun:test'
import { connectOrBootstrap } from '../../src/client/bootstrap'
import * as socketModule from '../../src/client/socket'
import type { ConnectionState } from '../../src/client/types'
import { protocolVersion } from '../../src/protocol'
import * as registryModule from '../../src/registry'

afterEach(() => {
  vi.restoreAllMocks()
})

test('connectOrBootstrap skips stale registrations from dead processes', async () => {
  const runtimeDir = '/tmp/cli-lane-stale-registration-test'
  const registrationPath = `${runtimeDir}/registration.json`
  const staleRegistration = {
    pid: 999_999,
    port: 41_001,
    token: 'stale-token',
    startedAt: 1,
    version: '0.1.0',
    protocolVersion,
  }
  const freshRegistration = {
    pid: process.pid,
    port: 41_002,
    token: 'fresh-token',
    startedAt: Date.now(),
    version: '0.1.0',
    protocolVersion,
  }

  vi.spyOn(registryModule, 'readRegistration').mockImplementation(
    async (filePath) => {
      expect(filePath).toBe(registrationPath)
      return staleRegistration
    },
  )
  const removeRegistration = vi
    .spyOn(registryModule, 'removeRegistration')
    .mockResolvedValue()

  const openSocket = vi.spyOn(socketModule, 'openSocket').mockResolvedValue({
    socket: null,
    buffer: '',
    history: [],
    waiters: [],
    heartbeatTimer: null,
    closed: false,
    bootstrappedServer: null,
    registration: freshRegistration,
    onMessage: undefined,
    onNotice: undefined,
    closePromise: Promise.resolve(),
    resolveClose: null,
  } as ConnectionState)
  const sendMessage = vi
    .spyOn(socketModule, 'sendMessage')
    .mockImplementation(() => {})
  vi.spyOn(socketModule, 'waitForMessage').mockResolvedValue({
    type: 'hello-ack',
    serverVersion: '0.1.0',
    protocolVersion,
  })

  const server = {
    port: freshRegistration.port,
    registrationPath,
    registration: freshRegistration,
    stop: async () => {},
  }

  const state = await connectOrBootstrap({
    runtimeDir,
    bootstrapIfMissing: true,
    startCoordinator: async () => server,
    clientVersion: '0.1.0',
  })

  expect(removeRegistration).toHaveBeenCalledWith(registrationPath)
  expect(openSocket).toHaveBeenCalledTimes(1)
  expect(openSocket).toHaveBeenCalledWith(
    freshRegistration.port,
    server,
    freshRegistration,
  )
  expect(sendMessage).toHaveBeenCalledWith(
    state,
    expect.objectContaining({
      type: 'hello',
      token: freshRegistration.token,
      protocolVersion,
    }),
  )
})

test('connectOrBootstrap keeps registrations when pid probe returns EPERM', async () => {
  const runtimeDir = '/tmp/cli-lane-eperm-registration-test'
  const registrationPath = `${runtimeDir}/registration.json`
  const existingRegistration = {
    pid: 999_998,
    port: 41_003,
    token: 'existing-token',
    startedAt: 1,
    version: '0.1.0',
    protocolVersion,
  }

  vi.spyOn(process, 'kill').mockImplementation(() => {
    const error = new Error('not permitted') as NodeJS.ErrnoException
    error.code = 'EPERM'
    throw error
  })
  vi.spyOn(registryModule, 'readRegistration').mockImplementation(
    async (filePath) => {
      expect(filePath).toBe(registrationPath)
      return existingRegistration
    },
  )
  const removeRegistration = vi
    .spyOn(registryModule, 'removeRegistration')
    .mockResolvedValue()

  const openSocket = vi.spyOn(socketModule, 'openSocket').mockResolvedValue({
    socket: null,
    buffer: '',
    history: [],
    waiters: [],
    heartbeatTimer: null,
    closed: false,
    bootstrappedServer: null,
    registration: existingRegistration,
    onMessage: undefined,
    onNotice: undefined,
    closePromise: Promise.resolve(),
    resolveClose: null,
  } as ConnectionState)
  vi.spyOn(socketModule, 'sendMessage').mockImplementation(() => {})
  vi.spyOn(socketModule, 'waitForMessage').mockResolvedValue({
    type: 'hello-ack',
    serverVersion: '0.1.0',
    protocolVersion,
  })

  const startCoordinator = vi.fn(async () => {
    throw new Error('startCoordinator should not run')
  })

  await connectOrBootstrap({
    runtimeDir,
    bootstrapIfMissing: true,
    startCoordinator,
    clientVersion: '0.1.0',
  })

  expect(removeRegistration).not.toHaveBeenCalled()
  expect(openSocket).toHaveBeenCalledWith(
    existingRegistration.port,
    null,
    existingRegistration,
  )
  expect(startCoordinator).not.toHaveBeenCalled()
})

test('connectOrBootstrap clears unreachable registrations before helper bootstrap', async () => {
  const runtimeDir = '/tmp/cli-lane-unreachable-registration-test'
  const registrationPath = `${runtimeDir}/registration.json`
  const existingRegistration = {
    pid: process.pid,
    port: 41_004,
    token: 'existing-token',
    startedAt: 1,
    version: '0.1.0',
    protocolVersion,
  }
  const freshRegistration = {
    pid: process.pid,
    port: 41_005,
    token: 'fresh-token',
    startedAt: Date.now(),
    version: '0.1.0',
    protocolVersion,
  }

  let readCount = 0
  vi.spyOn(registryModule, 'readRegistration').mockImplementation(
    async (filePath) => {
      expect(filePath).toBe(registrationPath)
      readCount += 1
      if (readCount === 1) {
        return existingRegistration
      }

      return freshRegistration
    },
  )
  const removeRegistration = vi
    .spyOn(registryModule, 'removeRegistration')
    .mockResolvedValue()

  const openSocket = vi
    .spyOn(socketModule, 'openSocket')
    .mockRejectedValueOnce(new Error('Failed to connect'))
    .mockResolvedValue({
      socket: null,
      buffer: '',
      history: [],
      waiters: [],
      heartbeatTimer: null,
      closed: false,
      bootstrappedServer: null,
      registration: freshRegistration,
      onMessage: undefined,
      onNotice: undefined,
      closePromise: Promise.resolve(),
      resolveClose: null,
    } as ConnectionState)
  vi.spyOn(socketModule, 'sendMessage').mockImplementation(() => {})
  vi.spyOn(socketModule, 'waitForMessage').mockResolvedValue({
    type: 'hello-ack',
    serverVersion: '0.1.0',
    protocolVersion,
  })
  const spawn = vi.spyOn(Bun, 'spawn').mockImplementation(() => {
    return {
      exitCode: 0,
      signalCode: null,
      kill() {},
      exited: Promise.resolve(0),
    } as never
  })

  const state = await connectOrBootstrap({
    runtimeDir,
    bootstrapIfMissing: true,
    startCoordinator: async () => {
      throw new Error('Failed to listen at 127.0.0.1:0')
    },
    clientVersion: '0.1.0',
  })

  expect(removeRegistration).toHaveBeenCalledTimes(1)
  expect(removeRegistration).toHaveBeenCalledWith(registrationPath)
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(openSocket).toHaveBeenNthCalledWith(
    1,
    existingRegistration.port,
    null,
    existingRegistration,
  )
  expect(openSocket).toHaveBeenNthCalledWith(
    2,
    freshRegistration.port,
    expect.objectContaining({
      port: freshRegistration.port,
      registrationPath,
      registration: freshRegistration,
    }),
    freshRegistration,
  )
  expect(state.registration).toEqual(freshRegistration)
})

test('connectOrBootstrap does not remove registration preemptively for helper bootstrap', async () => {
  const runtimeDir = '/tmp/cli-lane-helper-bootstrap-test'
  const registrationPath = `${runtimeDir}/registration.json`
  const freshRegistration = {
    pid: process.pid,
    port: 41_006,
    token: 'fresh-token',
    startedAt: Date.now(),
    version: '0.1.0',
    protocolVersion,
  }

  let readCount = 0
  vi.spyOn(registryModule, 'readRegistration').mockImplementation(
    async (filePath) => {
      expect(filePath).toBe(registrationPath)
      readCount += 1
      if (readCount === 1) {
        return null
      }

      return freshRegistration
    },
  )
  const removeRegistration = vi
    .spyOn(registryModule, 'removeRegistration')
    .mockResolvedValue()
  const openSocket = vi.spyOn(socketModule, 'openSocket').mockResolvedValue({
    socket: null,
    buffer: '',
    history: [],
    waiters: [],
    heartbeatTimer: null,
    closed: false,
    bootstrappedServer: null,
    registration: freshRegistration,
    onMessage: undefined,
    onNotice: undefined,
    closePromise: Promise.resolve(),
    resolveClose: null,
  } as ConnectionState)
  vi.spyOn(socketModule, 'sendMessage').mockImplementation(() => {})
  vi.spyOn(socketModule, 'waitForMessage').mockResolvedValue({
    type: 'hello-ack',
    serverVersion: '0.1.0',
    protocolVersion,
  })
  const spawn = vi.spyOn(Bun, 'spawn').mockImplementation(() => {
    return {
      exitCode: 0,
      signalCode: null,
      kill() {},
      exited: Promise.resolve(0),
    } as never
  })

  await connectOrBootstrap({
    runtimeDir,
    bootstrapIfMissing: true,
    startCoordinator: async () => {
      throw new Error('Failed to listen at 127.0.0.1:0')
    },
    clientVersion: '0.1.0',
  })

  expect(removeRegistration).not.toHaveBeenCalled()
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(openSocket).toHaveBeenCalledTimes(1)
  expect(openSocket).toHaveBeenCalledWith(
    freshRegistration.port,
    expect.objectContaining({
      port: freshRegistration.port,
      registrationPath,
      registration: freshRegistration,
    }),
    freshRegistration,
  )
})

test('connectOrBootstrap keeps registration on protocol mismatch', async () => {
  const runtimeDir = '/tmp/cli-lane-protocol-mismatch-test'
  const registrationPath = `${runtimeDir}/registration.json`
  const existingRegistration = {
    pid: process.pid,
    port: 41_007,
    token: 'existing-token',
    startedAt: 1,
    version: '0.1.0',
    protocolVersion,
  }

  vi.spyOn(registryModule, 'readRegistration').mockResolvedValue(
    existingRegistration,
  )
  const removeRegistration = vi
    .spyOn(registryModule, 'removeRegistration')
    .mockResolvedValue()
  vi.spyOn(socketModule, 'openSocket').mockResolvedValue({
    socket: null,
    buffer: '',
    history: [],
    waiters: [],
    heartbeatTimer: null,
    closed: false,
    bootstrappedServer: null,
    registration: existingRegistration,
    onMessage: undefined,
    onNotice: undefined,
    closePromise: Promise.resolve(),
    resolveClose: null,
  } as ConnectionState)
  vi.spyOn(socketModule, 'sendMessage').mockImplementation(() => {})
  vi.spyOn(socketModule, 'waitForMessage').mockResolvedValue({
    type: 'hello-ack',
    serverVersion: '0.1.0',
    protocolVersion: protocolVersion + 1,
  } as never)

  const startCoordinator = vi.fn(async () => {
    throw new Error('startCoordinator should not run')
  })

  await expect(
    connectOrBootstrap({
      runtimeDir,
      bootstrapIfMissing: true,
      startCoordinator,
      clientVersion: '0.1.0',
    }),
  ).rejects.toThrow('protocol mismatch')

  expect(removeRegistration).not.toHaveBeenCalledWith(registrationPath)
  expect(startCoordinator).not.toHaveBeenCalled()
})

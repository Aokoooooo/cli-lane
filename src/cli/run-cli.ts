import { loadConfig } from '../config'
import { startServer } from '../server'
import { cancelCommand } from './actions/cancel'
import { psCommand } from './actions/ps'
import { runCommand } from './actions/run'
import type { CliIO } from './types'

export async function runCli(args: string[], io: CliIO = {}): Promise<number> {
  const stdout = io.stdout ?? process.stdout
  const stderr = io.stderr ?? process.stderr

  if (args[0] === '__server__') {
    const runtimeDir = args[1]
    if (!runtimeDir) {
      throw new Error('Missing runtime directory for server mode')
    }

    await runCoordinatorServer(runtimeDir)
    return 0
  }

  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    stdout.write('cli-lane\n')
    return 0
  }

  const config = loadConfig(io.env ?? process.env, io.cwd ?? process.cwd())
  const [command, ...rest] = args

  switch (command) {
    case 'run':
      return await runCommand(rest, config, stdout, stderr)
    case 'ps':
      return await psCommand(config, stdout)
    case 'cancel':
      return await cancelCommand(rest, config, stdout)
    default:
      throw new Error('Unsupported arguments')
  }
}

async function runCoordinatorServer(runtimeDir: string): Promise<void> {
  const server = await startServer({ runtimeDir, listenHost: '127.0.0.1' })
  const shutdown = async () => {
    await server.stop()
  }

  process.once('SIGINT', () => {
    void shutdown().finally(() => process.exit(0))
  })
  process.once('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0))
  })

  await new Promise<void>(() => {
    // Keep the helper process alive until it is stopped from the outside or by idle timeout.
  })
}

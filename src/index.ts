#!/usr/bin/env bun

export type { CliIO } from './cli'
export { runCli } from './cli'
export type { Client, ClientOptions } from './client'
export { createClient } from './client'
export type { CoordinatorServer, StartServerOptions } from './server'
export { startServer } from './server'

if (import.meta.main) {
  try {
    const { runCli } = await import('./cli')
    const exitCode = await runCli(process.argv.slice(2))
    process.exit(exitCode)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    process.exit(1)
  }
}

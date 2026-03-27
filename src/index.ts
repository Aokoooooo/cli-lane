#!/usr/bin/env bun

export { runCli } from './cli'
export type { CliIO } from './cli'
export { createClient } from './client'
export type { Client, ClientOptions } from './client'
export { startServer } from './server'
export type { CoordinatorServer, StartServerOptions } from './server'

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

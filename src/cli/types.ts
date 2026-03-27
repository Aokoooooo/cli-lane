export type CliIO = {
  stdout?: { write(chunk: string): unknown }
  stderr?: { write(chunk: string): unknown }
  env?: Record<string, string | undefined>
  cwd?: string
}

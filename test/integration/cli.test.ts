import { expect, test } from 'bun:test'

test('cli prints help output', () => {
  const result = Bun.spawnSync(
    [process.execPath, 'run', 'src/index.ts', '--help'],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )

  expect(result.exitCode).toBe(0)
  const output = new TextDecoder().decode(result.stdout).trim()
  expect(output).toContain('cli-lane')
  expect(output).toContain('Usage:')
})

test('cli fails on unsupported arguments', () => {
  const result = Bun.spawnSync(
    [process.execPath, 'run', 'src/index.ts', 'unknown'],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )

  expect(result.exitCode).not.toBe(0)
})

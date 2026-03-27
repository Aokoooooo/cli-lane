import { afterEach, beforeEach, vi } from 'bun:test'

const originalEnv = { ...process.env }

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  process.env = { ...originalEnv }
  vi.resetAllMocks()
})

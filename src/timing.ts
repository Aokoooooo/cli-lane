export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message?: string,
): Promise<T> {
  return await Promise.race([
    promise,
    sleep(timeoutMs).then(() => {
      throw new Error(message ?? `timed out after ${timeoutMs}ms`)
    }),
  ])
}

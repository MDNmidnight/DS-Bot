// A phone on a flaky link (VPN, mobile data, a laptop that slept) loses sends that the
// computer never saw. Retry only the failures that are worth retrying: a `bot/*` code is
// the computer answering, so the same request will get the same answer; anything else
// (a dropped link, a timeout, no route at all) may succeed a moment later.
//
// A retried send carries the same requestId, and the host answers a repeated requestId
// without delivering twice — see the `send` endpoint in ds-bot/src/host/channel.js.

export const RETRY_DELAYS_MS = [700, 2200, 5000]

export function retryable(failure: unknown): boolean {
  const code = (failure as { code?: unknown } | null)?.code
  return !(typeof code === 'string' && code.startsWith('bot/'))
}

export interface RetryOptions {
  attempts?: number
  delaysMs?: readonly number[]
  wait?: (ms: number) => Promise<void>
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export async function withRetry<T>(run: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3
  const delays = options.delaysMs ?? RETRY_DELAYS_MS
  const wait = options.wait ?? sleep
  let last: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await run()
    } catch (failure) {
      last = failure
      if (!retryable(failure) || attempt === attempts - 1) throw failure
      await wait(delays[Math.min(attempt, delays.length - 1)] ?? 0)
    }
  }
  throw last
}

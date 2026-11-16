import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RETRY_DELAYS_MS, retryable, withRetry } from './send-retry.ts'

test('a bot answer is final, a broken link is not', () => {
  assert.equal(retryable(Object.assign(new Error('Nothing to send'), { code: 'bot/invalid' })), false)
  assert.equal(retryable(Object.assign(new Error('stale'), { code: 'bot/stale' })), false)
  assert.equal(retryable(new Error('socket closed')), true)
  assert.equal(retryable(Object.assign(new Error('offline'), { code: 'link/offline' })), true)
  assert.equal(retryable(undefined), true)
})

test('a dropped call is retried and the third attempt wins', async () => {
  const waits: number[] = []
  let calls = 0
  const value = await withRetry(async () => {
    calls += 1
    if (calls < 3) throw new Error('network')
    return 'ok'
  }, { wait: async ms => { waits.push(ms) } })
  assert.equal(value, 'ok')
  assert.equal(calls, 3)
  assert.deepEqual(waits, RETRY_DELAYS_MS.slice(0, 2))
})

test('a final bot answer is not retried', async () => {
  let calls = 0
  await assert.rejects(withRetry(async () => {
    calls += 1
    throw Object.assign(new Error('Nothing to send'), { code: 'bot/invalid' })
  }, { wait: async () => {} }), /Nothing to send/)
  assert.equal(calls, 1)
})

test('the last failure is thrown after every attempt', async () => {
  let calls = 0
  await assert.rejects(withRetry(async () => {
    calls += 1
    throw new Error(`try ${calls}`)
  }, { attempts: 2, wait: async () => {} }), /try 2/)
  assert.equal(calls, 2)
})

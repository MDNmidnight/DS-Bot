import assert from 'node:assert/strict'
import { test } from 'node:test'
import { weeklyFromRateLimits } from '../src/host/plan-usage.js'

const PAYLOAD = {
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: 29, windowDurationMins: 10080, resetsAt: 1795233339 },
    secondary: null,
    planType: 'prolite',
  },
}

test('the weekly window comes from the primary rate limit', () => {
  assert.deepEqual(weeklyFromRateLimits(PAYLOAD), {
    usedPercent: 29,
    windowMins: 10080,
    resetsAt: 1795233339,
    planType: 'prolite',
  })
})

test('a plan with no weekly window is left out instead of drawn as zero', () => {
  assert.equal(weeklyFromRateLimits({ rateLimits: { primary: null } }), undefined)
  assert.equal(weeklyFromRateLimits({}), undefined)
  assert.equal(weeklyFromRateLimits(null), undefined)
  const noPercent = { rateLimits: { primary: { windowDurationMins: 10080 } } }
  assert.equal(weeklyFromRateLimits(noPercent), undefined)
})

test('a reported percentage is kept inside 0-100 and the rest is optional', () => {
  const high = weeklyFromRateLimits({ rateLimits: { primary: { usedPercent: 140 } } })
  assert.equal(high.usedPercent, 100)
  assert.equal('resetsAt' in high, false)
  const negative = weeklyFromRateLimits({ rateLimits: { primary: { usedPercent: -3 } } })
  assert.equal(negative.usedPercent, 0)
})

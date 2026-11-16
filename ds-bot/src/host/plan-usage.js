// The model plan's remaining allowance, for the sidebar's usage marks. Codex reports
// one weekly window through its own app-server (`account/rateLimits/read`); OpenCode
// is read by the browser from the OpenCode usage plugin's same-origin proxy, so this
// module answers for Codex only.
//
// A read starts a short-lived `codex app-server` child. It is the same channel the
// desktop app uses, it loads no thread, and the result is cached so the sidebar's
// refresh never turns into a spawn per minute.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const CACHE_MS = 5 * 60_000
const RETRY_MS = 60_000
const REQUEST_TIMEOUT_MS = 15_000
const WEEK_MINUTES = 10080

// Read the Codex executable the same way the desktop bridge does: PATH first, then the
// Microsoft Store package the desktop app installs from.
export function locateCodex(configured) {
  if (typeof configured === 'string' && configured !== '' && existsSync(configured)) return configured
  for (const name of ['codex.exe', 'codex']) {
    try {
      const found = execFileSync('where', [name], { encoding: 'utf8', timeout: 5000 }).split(/\r?\n/)[0].trim()
      if (found !== '' && existsSync(found)) return found
    } catch { /* not on PATH */ }
  }
  try {
    const root = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "(Get-AppxPackage -Name 'OpenAI.Codex' | Select-Object -First 1).InstallLocation",
    ], { encoding: 'utf8', timeout: 15_000 }).trim()
    if (root !== '') {
      const exe = join(root, 'app', 'resources', 'codex.exe')
      if (existsSync(exe)) return exe
    }
  } catch { /* package not installed */ }
  return undefined
}

// One request/response round of `codex app-server --stdio`, enough for the rate limits.
function askCodex(exe, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = ''
    let nextId = 1
    const pending = new Map()
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill() } catch { /* already gone */ }
      if (error !== undefined) reject(error)
      else resolve(value)
    }
    const send = message => child.stdin.write(`${JSON.stringify(message)}\n`)
    const request = (name, requestParams = {}) => new Promise((requestResolve, requestReject) => {
      const id = nextId++
      pending.set(id, { resolve: requestResolve, reject: requestReject })
      send({ jsonrpc: '2.0', id, method: name, params: requestParams })
    })
    const timer = setTimeout(() => finish(new Error('Codex app-server timed out')), timeoutMs)
    child.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index === -1) break
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line === '') continue
        let message
        try { message = JSON.parse(line) } catch { continue }
        const entry = message.id === undefined ? undefined : pending.get(message.id)
        if (entry === undefined) continue
        pending.delete(message.id)
        if (message.error !== undefined) entry.reject(new Error(message.error.message ?? 'Codex refused the request'))
        else entry.resolve(message.result)
      }
    })
    child.on('error', error => finish(error))
    child.on('exit', code => {
      if (settled) return
      finish(new Error(`Codex app-server exited (${code ?? 'signal'})`))
    })
    request('initialize', {
      clientInfo: { name: 'ds-bot/plan-usage', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    }).then(() => {
      send({ jsonrpc: '2.0', method: 'initialized', params: {} })
      return request(method, params)
    }).then(value => finish(undefined, value), error => finish(error))
  })
}

// The weekly primary window the sidebar draws. Anything the payload does not carry —
// no window, no reset, a plan without limits — is left out instead of guessed.
export function weeklyFromRateLimits(payload) {
  const limits = payload?.rateLimits ?? payload?.rateLimitsByLimitId?.codex
  const primary = limits?.primary
  if (primary === undefined || primary === null) return undefined
  const usedPercent = Number(primary.usedPercent)
  if (!Number.isFinite(usedPercent)) return undefined
  const windowMins = Number(primary.windowDurationMins)
  const resetsAt = Number(primary.resetsAt)
  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    ...(Number.isFinite(windowMins) && windowMins > 0 ? { windowMins } : {}),
    ...(Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAt } : {}),
    ...(typeof limits?.planType === 'string' ? { planType: limits.planType } : {}),
  }
}

let cache

/**
 * Read the Codex weekly window, cached.
 * @param {{ codexPath?: string, now?: () => number }} [options]
 * @returns {Promise<{ codex: object | null, reason?: string }>}
 */
export async function readCodexUsage(options = {}) {
  const now = options.now ?? Date.now
  if (cache !== undefined && now() - cache.at < (cache.value.codex === null ? RETRY_MS : CACHE_MS)) {
    return cache.value
  }
  let value
  const exe = locateCodex(options.codexPath)
  if (exe === undefined) {
    value = { codex: null, reason: 'codex-not-found' }
  } else {
    try {
      const payload = await askCodex(exe, 'account/rateLimits/read', {}, REQUEST_TIMEOUT_MS)
      const weekly = weeklyFromRateLimits(payload)
      value = weekly === undefined ? { codex: null, reason: 'codex-no-weekly-window' } : { codex: { weekly } }
    } catch (error) {
      value = { codex: null, reason: error instanceof Error ? error.message : String(error) }
    }
  }
  cache = { at: now(), value }
  return value
}

/** Drop the cache; used by tests and after a plan change. */
export function resetPlanUsageCache() {
  cache = undefined
}

export const WEEKLY_WINDOW_MINUTES = WEEK_MINUTES

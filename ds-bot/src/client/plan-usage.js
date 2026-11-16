import { createElement as h, useEffect, useState } from 'react'
import { call } from './api.js'
import { t } from './i18n.js'

// Model plan usage in the sidebar's own column. Codex has one weekly window; OpenCode
// has a rolling 5-hour, a weekly and a monthly one, drawn as concentric rings so the
// narrow rail still shows all three. Codex comes from the Bot channel (`plan-usage`,
// which asks the Codex app-server); OpenCode comes from the usage plugin's same-origin
// proxy, and is left out when that plugin is not installed.
const REFRESH_MS = 60_000

const clamp = value => (typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : undefined)

// "3d 4h" / "2h 10m" until an instant given in epoch seconds or ISO text.
export function untilText(at, now = Date.now()) {
  if (at === undefined || at === null) return ''
  const time = typeof at === 'number' ? at * 1000 : Date.parse(String(at))
  if (!Number.isFinite(time)) return ''
  const minutes = Math.round((time - now) / 60_000)
  if (minutes <= 0) return ''
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${Math.max(1, minutes)}m`
}

export function planRows(payload, now = Date.now()) {
  const rows = []
  const codex = payload?.codex?.weekly
  if (codex !== undefined) {
    rows.push({
      id: 'codex',
      name: 'Codex',
      percent: clamp(Number(codex.usedPercent)),
      window: t('Weekly'),
      reset: untilText(codex.resetsAt, now),
    })
  }
  const usage = payload?.opencode
  if (usage !== undefined) {
    const windows = [
      ['rolling', usage.rolling, usage.rollingWindow ?? '5h'],
      ['weekly', usage.weekly, t('Weekly')],
      ['monthly', usage.monthly, t('Monthly')],
    ]
    for (const [id, window, label] of windows) {
      if (window === undefined || window === null) continue
      rows.push({ id: `opencode-${id}`, name: id === 'rolling' ? 'OpenCode' : '', percent: clamp(Number(window.percent)), window: label, reset: untilText(window.resetsAt, now) })
    }
  }
  return rows
}

function Ring({ size, radius, percent, color, stroke }) {
  const center = size / 2
  const width = stroke ?? Math.max(2, Math.round(size / 12))
  const circumference = 2 * Math.PI * radius
  const used = ((percent ?? 0) / 100) * circumference
  const common = { cx: center, cy: center, r: radius, fill: 'none', 'stroke-width': width }
  return h('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, 'aria-hidden': true, className: 'bt-usage-ring' },
    h('circle', { ...common, stroke: 'var(--bt-line)' }),
    h('circle', {
      ...common,
      stroke: color,
      'stroke-linecap': 'round',
      'stroke-dasharray': `${used} ${circumference}`,
      transform: `rotate(-90 ${center} ${center})`,
    }))
}

const CODEX_COLOR = 'var(--bt-accent)'
const OPENCODE_COLOR = '#1783ff'
const OPENCODE_RINGS = [
  { key: 'rolling', radius: 13.5 },
  { key: 'weekly', radius: 10 },
  { key: 'monthly', radius: 6.5 },
]

function opencodeRingPercents(usage) {
  return OPENCODE_RINGS.map(ring => clamp(Number(usage?.[ring.key]?.percent)))
}

function Tip({ tip }) {
  if (tip === null) return null
  return h('div', { className: 'bt-usage-tip', style: { left: `${tip.x}px`, top: `${tip.y}px` }, role: 'tooltip' },
    tip.rows.map(row => h('div', { key: row.id, className: 'bt-usage-tip-row' },
      h('span', { className: 'bt-usage-tip-name' }, row.name),
      h('span', { className: 'bt-usage-tip-window' }, row.window),
      h('span', { className: 'bt-usage-tip-pct' }, row.percent === undefined ? '—' : `${Math.round(row.percent)}%`),
      row.reset === '' ? null : h('span', { className: 'bt-usage-tip-reset' }, t('{time} left', { time: row.reset })))),
    tip.rows.length === 0 ? h('div', { className: 'bt-usage-tip-row' }, t('Usage unavailable')) : null)
}

function usePlanUsage() {
  const [payload, setPayload] = useState({})
  useEffect(() => {
    let live = true
    const load = async () => {
      const [codex, opencode] = await Promise.all([readCodex(), readOpencode()])
      if (live) setPayload({ ...(codex === undefined ? {} : { codex }), ...(opencode === undefined ? {} : { opencode }) })
    }
    void load()
    const timer = setInterval(() => void load(), REFRESH_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])
  return payload
}

async function readCodex() {
  try {
    const answer = await call('plan-usage')
    return answer ?? undefined
  } catch {
    return undefined
  }
}

async function readOpencode() {
  try {
    // Document-relative, like the Bot channel's own route, so a mounted base path works.
    const response = await fetch('opencode-go/usage', { credentials: 'same-origin' })
    if (!response.ok) return undefined
    const body = await response.json()
    const usage = body?.usage
    if (usage === undefined || usage === null) return undefined
    return { ...usage, rollingWindow: body?.labels?.rollingWindow }
  } catch {
    return undefined
  }
}

function useTip(rows) {
  const [tip, setTip] = useState(null)
  const show = (event) => {
    const box = event.currentTarget.getBoundingClientRect()
    setTip({ x: Math.round(box.right + 10), y: Math.round(box.top - 4), rows })
  }
  const hide = () => setTip(null)
  return { tip, show, hide }
}

/**
 * The plan-usage marks: two rings on the narrow rail, rows with percentages when the
 * column is open. Hovering either shows every window with its reset time.
 */
export function PlanUsage({ layout }) {
  const payload = usePlanUsage()
  const rows = planRows(payload)
  const { tip, show, hide } = useTip(rows)
  const codex = rows.find(row => row.id === 'codex')
  const percents = opencodeRingPercents(payload.opencode)
  const rail = layout === 'rail'
  const nest = (size, strokeScale) => h('span', { className: 'bt-usage-nest' }, OPENCODE_RINGS.map((ring, index) => h('span', { key: ring.key, className: 'bt-usage-nest-ring' },
    h(Ring, { size, radius: ring.radius * strokeScale, percent: percents[index], color: OPENCODE_COLOR, stroke: rail ? 2.6 : 2 }))))
  const codexDetail = codex === undefined ? '—' : `${Math.round(codex.percent ?? 0)}%`
  const opencodeDetail = OPENCODE_RINGS.map((ring, index) => {
    const label = ring.key === 'rolling' ? (payload.opencode?.rollingWindow ?? '5h') : ring.key === 'weekly' ? t('Weekly') : t('Monthly')
    return `${label} ${percents[index] === undefined ? '—' : `${Math.round(percents[index])}%`}`
  }).join(' · ')
  const codexMark = h('div', { className: 'bt-usage-mark', onMouseEnter: show, onMouseLeave: hide, tabIndex: 0, 'aria-label': t('Codex usage') },
    h(Ring, { size: rail ? 30 : 22, radius: rail ? 12 : 8.5, percent: codex?.percent, color: CODEX_COLOR }),
    rail ? null : h('span', { className: 'bt-usage-text' }, h('span', { className: 'bt-usage-name' }, 'Codex'), h('span', { className: 'bt-usage-detail' }, codexDetail)))
  const showOpencode = rail || payload.opencode !== undefined
  const opencodeMark = showOpencode
    ? h('div', { className: 'bt-usage-mark', onMouseEnter: show, onMouseLeave: hide, tabIndex: 0, 'aria-label': t('OpenCode usage') },
        nest(rail ? 30 : 22, rail ? 1 : 0.73),
        rail ? null : h('span', { className: 'bt-usage-text' }, h('span', { className: 'bt-usage-name' }, 'OpenCode'), h('span', { className: 'bt-usage-detail' }, opencodeDetail)))
    : null
  return h('div', { className: 'bt-usage-wrap' },
    h('div', { className: rail ? 'bt-usage bt-usage-rail' : 'bt-usage bt-usage-side' }, codexMark, opencodeMark),
    h(Tip, { tip }))
}

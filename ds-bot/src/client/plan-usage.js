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

function Ring({ size, radius, percent, color, stroke, opacity }) {
  const center = size / 2
  const width = stroke ?? Math.max(2, Math.round(size / 12))
  const circumference = 2 * Math.PI * radius
  // A plan starts full and this ring shows what is left, so a fresh window is a closed
  // circle and a spent one is empty. The percentage beside it is the used share.
  const remaining = percent === undefined ? 0 : Math.max(0, 100 - percent)
  const shown = (remaining / 100) * circumference
  const common = { cx: center, cy: center, r: radius, fill: 'none', 'stroke-width': width }
  return h('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, 'aria-hidden': true, className: 'bt-usage-ring' },
    h('circle', { ...common, stroke: 'var(--bt-line)' }),
    h('circle', {
      ...common,
      stroke: color,
      'stroke-opacity': opacity ?? 1,
      'stroke-linecap': 'round',
      'stroke-dasharray': `${shown} ${circumference}`,
      transform: `rotate(-90 ${center} ${center})`,
    }))
}

const CODEX_COLOR = 'var(--bt-accent)'
const OPENCODE_COLOR = 'var(--bt-accent)'
// Both marks are the same box as the rail's round buttons, so the rings line up with
// them instead of drifting left. OpenCode's three windows are the same circle at three
// radii, told apart by opacity rather than by a second color.
const RAIL_STYLE = { size: 36, codexRadius: 15, codexStroke: 3, rings: [[15, 1], [11, 0.66], [7, 0.42]], ringStroke: 2.6 }
const SIDE_STYLE = { size: 24, codexRadius: 9.6, codexStroke: 2.4, rings: [[9.6, 1], [7, 0.66], [4.4, 0.42]], ringStroke: 2 }
const OPENCODE_KEYS = ['rolling', 'weekly', 'monthly']

function opencodeRingPercents(usage) {
  return OPENCODE_KEYS.map(key => clamp(Number(usage?.[key]?.percent)))
}

// One line per window: its label, a bar that drains with the plan, the used percentage,
// then the reset countdown underneath. Bars and rings tell the same story (what is
// left), so a nearly full bar always means "barely used".
function Tip({ tip }) {
  if (tip === null) return null
  const rows = tip.rows
  return h('div', { className: 'bt-usage-tip', style: { left: `${tip.x}px`, top: `${tip.y}px` }, role: 'tooltip' },
    h('div', { className: 'bt-usage-tip-head' }, tip.title),
    rows.length === 0 ? h('div', { className: 'bt-usage-tip-reset' }, t('Usage unavailable')) : null,
    rows.map(row => h('div', { key: row.id, className: 'bt-usage-tip-item' },
      h('div', { className: 'bt-usage-tip-row' },
        h('span', { className: 'bt-usage-tip-window' }, row.window),
        h('span', { className: 'bt-usage-tip-bar' },
          h('span', { className: 'bt-usage-tip-fill', style: { width: `${row.percent === undefined ? 0 : Math.max(0, 100 - row.percent)}%` } })),
        h('span', { className: 'bt-usage-tip-pct' }, row.percent === undefined ? '—' : `${Math.round(row.percent)}%`)),
      row.reset === '' ? null : h('div', { className: 'bt-usage-tip-reset' }, t('{time} left', { time: row.reset })))))
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

// Each mark carries its own title and rows: a hover on Codex must never list OpenCode's
// windows.
function useTip() {
  const [tip, setTip] = useState(null)
  const show = (title, rows) => event => {
    const box = event.currentTarget.getBoundingClientRect()
    setTip({ x: Math.round(box.right + 10), y: Math.round(box.top - 4), title, rows })
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
  const { tip, show, hide } = useTip()
  const rail = layout === 'rail'
  const style = rail ? RAIL_STYLE : SIDE_STYLE
  const codexRows = rows.filter(row => row.id === 'codex')
  const opencodeRows = rows.filter(row => row.id.startsWith('opencode'))
  const codex = codexRows[0]
  const percents = opencodeRingPercents(payload.opencode)
  const percentText = value => (value === undefined ? '—' : `${Math.round(value)}%`)
  const nest = h('span', { className: 'bt-usage-nest', style: { width: `${style.size}px`, height: `${style.size}px` } },
    style.rings.map(([radius, opacity], index) => h('span', { key: OPENCODE_KEYS[index], className: 'bt-usage-nest-ring' },
      h(Ring, { size: style.size, radius, percent: percents[index], color: OPENCODE_COLOR, stroke: style.ringStroke, opacity }))))
  const codexDetail = codex === undefined ? '—' : `${percentText(codex.percent)} ${t('used')}`
  const opencodeDetail = OPENCODE_KEYS.map((key, index) => {
    const label = key === 'rolling' ? (payload.opencode?.rollingWindow ?? '5h') : key === 'weekly' ? t('Weekly') : t('Monthly')
    return `${label} ${percentText(percents[index])}`
  }).join(' · ')
  const codexMark = h('div', { className: 'bt-usage-mark', onMouseEnter: show('Codex', codexRows), onMouseLeave: hide, tabIndex: 0, 'aria-label': t('Codex usage') },
    h(Ring, { size: style.size, radius: style.codexRadius, percent: codex?.percent, color: CODEX_COLOR, stroke: style.codexStroke }),
    rail ? null : h('span', { className: 'bt-usage-text' }, h('span', { className: 'bt-usage-name' }, 'Codex'), h('span', { className: 'bt-usage-detail' }, codexDetail)))
  const showOpencode = rail || payload.opencode !== undefined
  const opencodeMark = showOpencode
    ? h('div', { className: 'bt-usage-mark', onMouseEnter: show('OpenCode', opencodeRows), onMouseLeave: hide, tabIndex: 0, 'aria-label': t('OpenCode usage') },
        nest,
        rail ? null : h('span', { className: 'bt-usage-text' }, h('span', { className: 'bt-usage-name' }, 'OpenCode'), h('span', { className: 'bt-usage-detail' }, opencodeDetail)))
    : null
  return h('div', { className: 'bt-usage-wrap' },
    h('div', { className: rail ? 'bt-usage bt-usage-rail' : 'bt-usage bt-usage-side' }, codexMark, opencodeMark),
    h(Tip, { tip }))
}

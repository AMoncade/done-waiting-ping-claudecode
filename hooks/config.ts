import type { PluginOptions } from 'claude-code'

// What the person chose, from the plugin's userConfig (set at install time or in /config),
// possibly overridden for a field by the /ping command.

export type Events = 'both' | 'done' | 'waiting'
export type Delivery = 'popup+sound' | 'popup' | 'sound'
export type SoundChoice = 'default' | 'message' | 'mail' | 'reminder' | 'custom' | 'none'
export type Language = 'en' | 'fr'

export type Config = {
  enabled: boolean
  events: Events
  delivery: Delivery
  doneAfterSeconds: number
  doneSound: SoundChoice
  waitingSound: SoundChoice
  doneSoundFile: string
  waitingSoundFile: string
  idleReminder: boolean
  showDetails: boolean
  quietWhenFocused: boolean
  focusApps: string[]
  language: Language
}

export const EVENTS: readonly Events[] = ['both', 'done', 'waiting']
export const DELIVERIES: readonly Delivery[] = ['popup+sound', 'popup', 'sound']
export const SOUNDS: readonly SoundChoice[] = ['default', 'message', 'mail', 'reminder', 'custom', 'none']
export const LANGUAGES: readonly Language[] = ['en', 'fr']

export const MAX_DONE_AFTER_SECONDS = 24 * 60 * 60

export const DEFAULTS: Config = {
  enabled: true,
  events: 'both',
  delivery: 'popup+sound',
  doneAfterSeconds: 60,
  doneSound: 'default',
  waitingSound: 'reminder',
  doneSoundFile: '',
  waitingSoundFile: '',
  idleReminder: false,
  showDetails: true,
  quietWhenFocused: false,
  focusApps: ['WindowsTerminal', 'Code', 'Cursor'],
  language: 'en',
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function seconds(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isFinite(n) && n >= 0 ? Math.min(n, MAX_DONE_AFTER_SECONDS) : fallback
}

// A file path as typed or pasted: Explorer's "Copy as path" wraps it in double quotes.
function path(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1).trim() : trimmed
}

export function appList(value: unknown, fallback: string[]): string[] {
  if (typeof value !== 'string') return fallback
  return value
    .split(/[,;]/)
    .map(part => part.trim())
    .filter(part => part !== '')
}

export function fromOptions(options: PluginOptions): Config {
  return {
    enabled: flag(options.enabled, DEFAULTS.enabled),
    events: pick(options.events, EVENTS, DEFAULTS.events),
    delivery: pick(options.delivery, DELIVERIES, DEFAULTS.delivery),
    doneAfterSeconds: seconds(options.doneAfterSeconds, DEFAULTS.doneAfterSeconds),
    doneSound: pick(options.doneSound, SOUNDS, DEFAULTS.doneSound),
    waitingSound: pick(options.waitingSound, SOUNDS, DEFAULTS.waitingSound),
    doneSoundFile: path(options.doneSoundFile),
    waitingSoundFile: path(options.waitingSoundFile),
    idleReminder: flag(options.idleReminder, DEFAULTS.idleReminder),
    showDetails: flag(options.showDetails, DEFAULTS.showDetails),
    quietWhenFocused: flag(options.quietWhenFocused, DEFAULTS.quietWhenFocused),
    focusApps: appList(options.focusApps, DEFAULTS.focusApps),
    language: pick(options.language, LANGUAGES, DEFAULTS.language),
  }
}

// The fields /ping can change. Each override remembers the /config value it was made over
// (`base`): when that value has changed since, the person edited /config, and /config wins.
export type OverrideField = 'enabled' | 'events' | 'delivery' | 'doneAfterSeconds'
export const OVERRIDE_FIELDS: readonly OverrideField[] = ['enabled', 'events', 'delivery', 'doneAfterSeconds']
export type Override = { value: unknown; base: unknown }
export type Overrides = Partial<Record<OverrideField, Override>>

export function readOverrides(stored: unknown): Overrides {
  const out: Overrides = {}
  if (stored === null || typeof stored !== 'object') return out
  for (const field of OVERRIDE_FIELDS) {
    const entry = (stored as Record<string, unknown>)[field]
    if (entry !== null && typeof entry === 'object' && 'value' in entry && 'base' in entry) {
      out[field] = { value: (entry as Override).value, base: (entry as Override).base }
    }
  }
  return out
}

function validFor(field: OverrideField, value: unknown): boolean {
  switch (field) {
    case 'enabled':
      return typeof value === 'boolean'
    case 'events':
      return typeof value === 'string' && (EVENTS as readonly string[]).includes(value)
    case 'delivery':
      return typeof value === 'string' && (DELIVERIES as readonly string[]).includes(value)
    case 'doneAfterSeconds':
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_DONE_AFTER_SECONDS
  }
}

// The config in force, and the overrides still standing (stale or invalid ones are dropped).
export function applyOverrides(base: Config, overrides: Overrides): { config: Config; kept: Overrides } {
  const config: Config = { ...base, focusApps: [...base.focusApps] }
  const kept: Overrides = {}
  for (const field of OVERRIDE_FIELDS) {
    const entry = overrides[field]
    if (entry === undefined) continue
    if (entry.base !== base[field] || !validFor(field, entry.value)) continue
    ;(config as Record<OverrideField, unknown>)[field] = entry.value
    kept[field] = entry
  }
  return { config, kept }
}

// `90`, `90s`, `2m`, `2 min`, `1.5m`, `1h`: seconds, or null when it is not a duration.
export function parseDuration(input: string): number | null {
  const match = /^(\d+(?:[.,]\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/i.exec(input.trim())
  if (match === null) return null
  const amount = Number((match[1] ?? '').replace(',', '.'))
  const unit = (match[2] ?? 's').toLowerCase()
  const factor = unit.startsWith('h') ? 3600 : unit.startsWith('m') ? 60 : 1
  const total = Math.round(amount * factor)
  return Number.isFinite(total) && total <= MAX_DONE_AFTER_SECONDS ? total : null
}

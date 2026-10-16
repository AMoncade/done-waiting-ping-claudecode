import type { Config, Language, OverrideField, Overrides } from './config'
import type { Outcome, Platform, Reason } from './deliver'

// Every word a notification or the /ping command shows, in English and French.
// A notification carries the project folder's name, what happened, a duration, a tool name and
// (with showDetails) the first line of Claude's question as written, code blocks and inline code
// left out. Never Claude's reply, a tool's input, or Claude Code's own notice text.

export type PingKind = 'done' | 'waiting' | 'idle'
export type Ping = { kind: PingKind; title: string; body: string; tag: string }
export type DoneReason = 'answer' | 'error' | 'refusal'

const FALLBACK_PROJECT = 'Claude Code'

// The last segment of a path, on Windows (`C:\work\shop`) as on macOS/Linux (`/work/shop`).
export function projectName(path: string | undefined | null): string {
  if (typeof path !== 'string') return FALLBACK_PROJECT
  const parts = path.split(/[\\/]+/).filter(part => part !== '')
  return parts[parts.length - 1] ?? FALLBACK_PROJECT
}

// `45s`, `4m 12s`, `1h 05m` in English; `45 s`, `4 min 12 s`, `1 h 05` in French.
export function duration(ms: number, lang: Language): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const two = (n: number) => String(n).padStart(2, '0')
  if (lang === 'fr') {
    if (h > 0) return `${h} h ${two(m)}`
    if (m > 0) return `${m} min ${two(s)} s`
    return `${s} s`
  }
  if (h > 0) return `${h}h ${two(m)}m`
  if (m > 0) return `${m}m ${two(s)}s`
  return `${s}s`
}

// The first line of Claude's markdown question as plain text: code blocks and inline code left
// out, links reduced to their text, emphasis marks removed (underscores in names are kept).
export function snippet(markdown: unknown, max = 100): string {
  if (typeof markdown !== 'string') return ''
  const withoutBlocks = markdown.replace(/[￾￿]/g, '').replace(/```[\s\S]*?(```|$)/g, '\n')
  const first = withoutBlocks.split(/\r?\n/).find(lineText => lineText.trim() !== '') ?? ''
  const plain = first
    .replace(/`[^`]*`/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/, '')
    .replace(/[*~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (plain.length <= max) return plain
  return `${plain.slice(0, max - 1).trimEnd()}\u2026`
}

// From an SDK or desktop host's notice ("Claude needs your permission to use Bash"), the tool.
// The terminal's notice never names it ("Claude needs your permission").
export function toolFromMessage(message: unknown): string | null {
  if (typeof message !== 'string') return null
  const match = /permission to use (.+?)\.?\s*$/i.exec(message)
  if (match === null) return null
  const tool = (match[1] ?? '').trim()
  return tool === '' || tool.length > 60 ? null : tool
}

function tagFor(kind: PingKind, project: string): string {
  const slug = project.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return `${kind}-${slug || 'claude'}`
}

const WORDS = {
  en: {
    doneTitle: 'Claude Code is done',
    stoppedTitle: 'Claude Code stopped',
    waitingTitle: 'Claude Code needs you',
    idleTitle: 'Claude Code is waiting',
    finished: (took: string) => `finished in ${took}`,
    error: (took: string) => `stopped on an error after ${took}`,
    refusal: (took: string) => `declined the request after ${took}`,
    permissionFor: (tool: string) => `permission needed: ${tool}`,
    permission: 'needs your permission',
    question: 'has a question',
    questionFor: (q: string) => `question: ${q}`,
    plan: 'plan ready for your approval',
    mcp: 'an MCP server needs your input',
    agent: 'needs your input',
    other: 'needs your attention',
    idle: 'waiting for your next message',
  },
  fr: {
    doneTitle: 'Claude Code a terminé',
    stoppedTitle: "Claude Code s'est arrêté",
    waitingTitle: 'Claude Code a besoin de toi',
    idleTitle: "Claude Code t'attend",
    finished: (took: string) => `terminé en ${took}`,
    error: (took: string) => `arrêté par une erreur après ${took}`,
    refusal: (took: string) => `a refusé la demande après ${took}`,
    permissionFor: (tool: string) => `permission requise : ${tool}`,
    permission: 'demande ta permission',
    question: 'a une question',
    questionFor: (q: string) => `question : ${q}`,
    plan: 'plan prêt, à approuver',
    mcp: 'un serveur MCP attend ta réponse',
    agent: 'attend ta réponse',
    other: 'attend ta décision',
    idle: 'attend ton prochain message',
  },
} as const

const line = (project: string, detail: string) => `${project} \u00b7 ${detail}`

export function donePing(lang: Language, project: string, reason: DoneReason, ms: number): Ping {
  const w = WORDS[lang]
  const took = duration(ms, lang)
  const detail = reason === 'error' ? w.error(took) : reason === 'refusal' ? w.refusal(took) : w.finished(took)
  return { kind: 'done', title: reason === 'answer' ? w.doneTitle : w.stoppedTitle, body: line(project, detail), tag: tagFor('done', project) }
}

export type WaitingWhy =
  | { why: 'permission'; tool?: string }
  | { why: 'question'; question?: string }
  | { why: 'plan' }
  | { why: 'mcp' }
  | { why: 'agent' }
  | { why: 'other' }

export function waitingPing(lang: Language, project: string, what: WaitingWhy, showDetails: boolean): Ping {
  const w = WORDS[lang]
  let detail: string
  switch (what.why) {
    case 'permission':
      detail = showDetails && what.tool ? w.permissionFor(what.tool) : w.permission
      break
    case 'question': {
      const q = showDetails ? snippet(what.question) : ''
      detail = q === '' ? w.question : w.questionFor(q)
      break
    }
    case 'plan':
      detail = w.plan
      break
    case 'mcp':
      detail = w.mcp
      break
    case 'agent':
      detail = w.agent
      break
    case 'other':
      detail = w.other
      break
    default: {
      const never: never = what
      return never
    }
  }
  return { kind: 'waiting', title: w.waitingTitle, body: line(project, detail), tag: tagFor('waiting', project) }
}

export function idlePing(lang: Language, project: string): Ping {
  const w = WORDS[lang]
  return { kind: 'idle', title: w.idleTitle, body: line(project, w.idle), tag: tagFor('idle', project) }
}

// ---- the /ping command's own text ----

const EVENT_LABEL = {
  en: { both: 'done + waiting', done: 'done only', waiting: 'waiting only' },
  fr: { both: 'terminé + attente', done: 'terminé seulement', waiting: 'attente seulement' },
} as const

const DELIVERY_LABEL = {
  en: { 'popup+sound': 'popup + sound', popup: 'popup only', sound: 'sound only' },
  fr: { 'popup+sound': 'popup + son', popup: 'popup seulement', sound: 'son seulement' },
} as const

const FIELD_LABEL: Record<Language, Record<OverrideField, string>> = {
  en: { enabled: 'Notifications on', events: 'What to ping for', delivery: 'How to ping', doneAfterSeconds: 'Done: minimum turn length' },
  fr: { enabled: 'Notifications', events: 'Quoi notifier', delivery: 'Comment notifier', doneAfterSeconds: 'Durée minimale d’un tour' },
}

const REASON_TEXT: Record<Language, Record<Reason, string>> = {
  en: {
    ok: '',
    'ok-sound-fallback': 'your custom sound could not be used (missing, not a .wav, or a format Windows cannot play); the default sound played instead',
    'ok-sound-failed': 'no sound could be played',
    'ok-unconfirmed': 'the banner was shown but Windows did not keep it in the notification center',
    'ok-scheme-silent': 'your Windows sound scheme sets this sound to (None)',
    'nothing-to-do': 'delivery is sound only and the sound is none',
    focus: 'one of your "looking" apps had the focus',
    headless: 'headless run (claude -p): nothing is shown',
    ssh: 'over SSH: the terminal notification is used instead of the remote desktop',
    'toast-off-app': 'notifications are turned off for Windows PowerShell (Settings > System > Notifications)',
    'toast-off-all': 'notifications are turned off for all apps (Settings > System > Notifications)',
    'toast-off-policy': 'your organization blocks notifications on this computer',
    'toast-dropped': 'Windows did not show the notification',
    'cannot-start': 'the notifier could not start',
    'script-error': 'the notifier failed',
    'popup-failed': 'the popup could not be shown',
    'sound-failed': 'no sound could be played',
    'unsupported-system': 'this system has no notifier this mod knows',
  },
  fr: {
    ok: '',
    'ok-sound-fallback': 'ton son perso est inutilisable (introuvable, pas un .wav, ou un format que Windows ne lit pas) ; le son par défaut a joué à la place',
    'ok-sound-failed': 'aucun son n’a pu jouer',
    'ok-unconfirmed': 'la bannière s’est affichée mais Windows ne l’a pas gardée dans le centre de notifications',
    'ok-scheme-silent': 'ton jeu de sons Windows règle ce son sur (Aucun)',
    'nothing-to-do': 'envoi en son seulement, et le son est « none »',
    focus: 'une de tes applis « je regarde » était au premier plan',
    headless: 'exécution sans interface (claude -p) : rien n’est affiché',
    ssh: 'en SSH : la notification du terminal remplace celle du bureau distant',
    'toast-off-app': 'les notifications sont coupées pour Windows PowerShell (Paramètres > Système > Notifications)',
    'toast-off-all': 'les notifications sont coupées pour toutes les applis (Paramètres > Système > Notifications)',
    'toast-off-policy': 'ton organisation bloque les notifications sur cet ordinateur',
    'toast-dropped': 'Windows n’a pas affiché la notification',
    'cannot-start': 'le notificateur n’a pas pu démarrer',
    'script-error': 'le notificateur a échoué',
    'popup-failed': 'la popup n’a pas pu s’afficher',
    'sound-failed': 'aucun son n’a pu jouer',
    'unsupported-system': 'ce système n’a pas de notificateur connu du mod',
  },
}

export function reasonText(reason: Reason, lang: Language): string {
  return REASON_TEXT[lang][reason]
}

export function eventsLabel(config: Config): string {
  return EVENT_LABEL[config.language][config.events]
}

export function deliveryLabel(config: Config): string {
  return DELIVERY_LABEL[config.language][config.delivery]
}

function seconds(ms: number, lang: Language): string {
  const text = (ms / 1000).toFixed(1)
  return lang === 'fr' ? `${text.replace('.', ',')} s` : `${text} s`
}

export function describeOutcome(outcome: Outcome, config: Config, platform: Platform): string {
  const lang = config.language
  const fr = lang === 'fr'
  const why = reasonText(outcome.reason, lang)
  const took = seconds(outcome.ms, lang)
  let text: string
  switch (outcome.status) {
    case 'sent':
      text = fr
        ? `Envoyé (${deliveryLabel(config)}, via ${outcome.via}, ${took})${why ? ` ; ${why}` : ''}.`
        : `Sent (${deliveryLabel(config)}, via ${outcome.via}, ${took})${why ? `; ${why}` : ''}.`
      break
    case 'skipped':
      text = fr ? `Rien envoyé : ${why}.` : `Nothing sent: ${why}.`
      break
    case 'fallback':
      text = fr
        ? `La notification du système a échoué (${why}) ; la notification du terminal a été envoyée à la place. Détail : ${outcome.detail}`
        : `The system notification failed (${why}); the terminal notification was sent instead. Detail: ${outcome.detail}`
      break
    case 'failed':
      text = fr ? `Impossible de notifier (${why}). Détail : ${outcome.detail}` : `Could not notify (${why}). Detail: ${outcome.detail}`
      break
    default: {
      const never: never = outcome.status
      return never
    }
  }
  if (platform === 'macos' && outcome.status === 'sent' && outcome.via === 'osascript') {
    text += fr
      ? ' Si rien ne s’est affiché, autorise les notifications de « Éditeur de script » dans Réglages Système > Notifications.'
      : ' If nothing appeared, allow notifications for Script Editor in System Settings > Notifications.'
  }
  return text
}

export function statusText(config: Config, overrides: Overrides, platform: Platform, platformLabel: string, last: string | null): string {
  const lang = config.language
  const fr = lang === 'fr'
  const lines = [
    fr ? `done-waiting-ping : ${config.enabled ? 'activé' : 'coupé'}` : `done-waiting-ping: ${config.enabled ? 'on' : 'off'}`,
    fr
      ? `Événements : ${eventsLabel(config)} · Envoi : ${deliveryLabel(config)}`
      : `Events: ${eventsLabel(config)} · Delivery: ${deliveryLabel(config)}`,
    fr
      ? `Ping « terminé » après : ${duration(config.doneAfterSeconds * 1000, 'fr')} sans interaction · Sons : terminé = ${config.doneSound}, attente = ${config.waitingSound}`
      : `Done after: ${duration(config.doneAfterSeconds * 1000, 'en')} without interaction · Sounds: done = ${config.doneSound}, waiting = ${config.waitingSound}`,
    fr ? `Système : ${platformLabel}` : `Platform: ${platformLabel}`,
  ]
  if (config.idleReminder) lines.push(fr ? 'Rappel quand Claude reste inactif : oui' : 'Idle reminder: on')
  if (config.quietWhenFocused) {
    if (platform === 'linux' || platform === 'unknown') {
      lines.push(fr ? 'Silence quand tu regardes : non disponible sur ce système' : 'Quiet while looking: not available on this system')
    } else {
      lines.push(fr ? `Silence quand tu regardes : ${config.focusApps.join(', ')}` : `Quiet while looking: ${config.focusApps.join(', ')}`)
    }
  }
  if (last !== null) lines.push(fr ? `Dernier envoi : ${last}` : `Last ping: ${last}`)
  const overridden = (Object.keys(overrides) as OverrideField[]).map(field => FIELD_LABEL[lang][field])
  if (overridden.length > 0) {
    lines.push(
      fr
        ? `Changé avec /ping : ${overridden.join(', ')} (/ping reset pour revenir à /config)`
        : `Set with /ping: ${overridden.join(', ')} (/ping reset goes back to /config)`,
    )
  }
  return lines.join('\n')
}

export function helpText(lang: Language): string {
  if (lang === 'fr') {
    return [
      'Usage : /ping [commande]',
      '  (rien) ou status                     état actuel',
      '  on | off                             active ou coupe tout',
      '  done | waiting | both                quoi notifier (aussi : terminé, attente, tout)',
      '  popup | sound | popup+sound          comment notifier (aussi : son, popup+son)',
      '  90 | 2m | 1h                         durée sans interaction avant le ping « terminé »',
      '  test [done|waiting]                  envoie une notification d’essai (aussi : test attente)',
      '  reset                                oublie les choix faits avec /ping (retour à /config)',
      'Le reste (sons, fichier son perso, langue, détails, rappel inactif) : /config.',
    ].join('\n')
  }
  return [
    'Usage: /ping [command]',
    '  (nothing) or status                  current settings',
    '  on | off                             turn every ping on or off',
    '  done | waiting | both                which events ping',
    '  popup | sound | popup+sound          popup, sound, or both',
    '  90 | 2m | 1h                         time without interaction before the done ping',
    '  test [done|waiting]                  send a sample notification now',
    '  reset                                forget choices made with /ping (back to /config)',
    'Everything else (sounds, custom sound file, language, details, idle reminder): /config.',
  ].join('\n')
}

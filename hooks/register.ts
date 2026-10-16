import type { EngineInterface, Register } from 'claude-code'
import {
  applyOverrides,
  DEFAULTS,
  DELIVERIES,
  EVENTS,
  fromOptions,
  parseDuration,
  readOverrides,
  type Config,
  type Delivery,
  type Events,
  type OverrideField,
  type Overrides,
} from './config'
import { deliver, detectPlatform, PLATFORM_LABEL, type Outcome, type Platform, type Request } from './deliver'
import {
  deliveryLabel,
  describeOutcome,
  donePing,
  duration,
  eventsLabel,
  helpText,
  idlePing,
  projectName,
  statusText,
  toolFromMessage,
  waitingPing,
  type DoneReason,
  type Ping,
  type WaitingWhy,
} from './text'

// done-waiting-ping: a notification (popup, sound, or both) when a long turn is done and when
// Claude Code is waiting on you.
//
//   waiting  Claude Code's own "needs your input" notice (classic.Notification). It raises one
//            per dialog, and only once the dialog has stayed open about 6 s with no keypress, so
//            nothing pings while you are answering. While a question or plan dialog is open
//            (tool.call AskUserQuestion / ExitPlanMode) the notice is worded as that question
//            or plan; a permission prompt's tool comes from classic.PermissionRequest, only when
//            exactly one request is pending (never a wrong name, sometimes none).
//   done     turn.complete of the main conversation, not interrupted, when at least
//            doneAfterSeconds have passed since you last interacted: the turn's start, or the
//            moment you answered a question or a plan. Claude Code does not tell plugins when you
//            answer a permission prompt, so that wait counts as time away.
//   idle     optional: Claude Code's idle notice ("waiting for your input").
// Headless runs (claude -p and SDK hosts: CLAUDE_CODE_ENTRYPOINT sdk-*) never ping.

const COMMAND = 'ping'
const STORE_KEY = 'overrides'
const SAME_NOTICE_MS = 2_000
const PENDING_REQUEST_MS = 60_000
const WAITING_TYPES = new Set(['permission_prompt', 'worker_permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'])

type OpenDialog = { why: 'question' | 'plan'; question?: string }

type Session = {
  base: Config
  config: Config
  overrides: Overrides
  started: Promise<void> | null
  platform: Promise<Platform> | null
  project: string
  isInteractive: boolean | null
  // The latest moment you answered a question or plan in the current main turn (null: none).
  turnInteractionAt: number | null
  lastNotice: { key: string; at: number } | null
  openDialog: OpenDialog | null
  requests: Array<{ tool: string; at: number }>
  last: Outcome | null
}

function freshSession(base: Config): Session {
  return {
    base,
    config: base,
    overrides: {},
    started: null,
    platform: null,
    project: 'Claude Code',
    isInteractive: null,
    turnInteractionAt: null,
    lastNotice: null,
    openDialog: null,
    requests: [],
    last: null,
  }
}

let session: Session = freshSession(DEFAULTS)

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function debug($: EngineInterface, text: string): void {
  $.ui.log(`done-waiting-ping: ${text}`, { to: 'debug' })
}

// Choices made with /ping live in the plugin's store, shared by every session: read them again
// before each decision, so `/ping off` in one terminal also quiets the others.
async function refreshOverrides($: EngineInterface): Promise<void> {
  try {
    const stored = readOverrides(await $.store.get(STORE_KEY))
    const { config, kept } = applyOverrides(session.base, stored)
    session.config = config
    session.overrides = kept
    if (Object.keys(kept).length !== Object.keys(stored).length) await $.store.set(STORE_KEY, kept)
  } catch (error) {
    debug($, `could not read saved /ping choices (${errorText(error)})`)
  }
}

async function startSession($: EngineInterface, cwd: string | undefined): Promise<void> {
  try {
    await $.command.register({
      name: COMMAND,
      description: 'done-waiting-ping: status, on/off, done/waiting/both, popup/sound, threshold, test',
      argumentHint: '[status|on|off|done|waiting|both|popup|sound|popup+sound|90|2m|test|reset|help]',
      immediate: true,
    })
  } catch (error) {
    debug($, `/${COMMAND} not registered (${errorText(error)})`)
  }
  await refreshOverrides($)
  try {
    session.project = projectName(await $.session.root())
  } catch {
    session.project = projectName(cwd)
  }
  void platformOf($)
}

// session.start registers the command; a plugin installed mid-session may never hear it, so
// every hook makes sure the start ran once.
async function ensureStarted($: EngineInterface, cwd?: string): Promise<void> {
  if (session.started === null) session.started = startSession($, cwd ?? (await $.session.cwd()))
  await session.started
}

async function platformOf($: EngineInterface): Promise<Platform> {
  if (session.platform === null) session.platform = detectPlatform($).catch(() => 'unknown' as const)
  return session.platform
}

// Nobody is watching a `claude -p` run or an SDK host: Claude Code marks them with an
// sdk-* entrypoint. VS Code's extension also draws no surface, yet a person is there.
async function headless($: EngineInterface): Promise<boolean> {
  const entrypoint = await $.env.get('CLAUDE_CODE_ENTRYPOINT')
  if (entrypoint !== undefined) return entrypoint.startsWith('sdk-')
  if (session.isInteractive !== null) return !session.isInteractive
  try {
    return (await $.session.surfaces()).length === 0
  } catch {
    return false
  }
}

async function send($: EngineInterface, ping: Ping, forced: boolean): Promise<Outcome> {
  const c = session.config
  if (!forced && (await headless($))) {
    debug($, `${ping.kind} skipped (headless)`)
    return { status: 'skipped', via: 'none', reason: 'headless', detail: 'headless run', ms: 0 }
  }
  const isDone = ping.kind === 'done'
  const request: Request = {
    ping,
    popup: c.delivery !== 'sound',
    sound: c.delivery === 'popup' ? 'none' : isDone ? c.doneSound : c.waitingSound,
    soundFile: isDone ? c.doneSoundFile : c.waitingSoundFile,
    quietWhenFocused: c.quietWhenFocused && !forced,
    quietApps: c.focusApps,
  }
  const outcome = await deliver($, await platformOf($), request)
  session.last = outcome
  debug($, `${ping.kind} ${outcome.status} via ${outcome.via} in ${outcome.ms} ms (${outcome.reason}: ${outcome.detail})`)
  return outcome
}

async function onDone($: EngineInterface, durationMs: number, isAborted: boolean, reason: string, interactionAt: number | null): Promise<void> {
  try {
    await ensureStarted($)
    await refreshOverrides($)
    const c = session.config
    if (!c.enabled || c.events === 'waiting') return
    if (isAborted || reason === 'aborted') return
    const sinceInteraction = interactionAt === null ? durationMs : (await $.clock.now()) - interactionAt
    if (Math.min(durationMs, sinceInteraction) < c.doneAfterSeconds * 1000) return
    const why: DoneReason = reason === 'error' ? 'error' : reason === 'refusal' ? 'refusal' : 'answer'
    await send($, donePing(c.language, session.project, why, durationMs), false)
  } catch (error) {
    debug($, `done ping failed (${errorText(error)})`)
  }
}

async function onWaiting($: EngineInterface, what: WaitingWhy): Promise<void> {
  try {
    await ensureStarted($)
    await refreshOverrides($)
    const c = session.config
    if (!c.enabled || c.events === 'done') return
    await send($, waitingPing(c.language, session.project, what, c.showDetails), false)
  } catch (error) {
    debug($, `waiting ping failed (${errorText(error)})`)
  }
}

async function onIdle($: EngineInterface): Promise<void> {
  try {
    await ensureStarted($)
    await refreshOverrides($)
    const c = session.config
    if (!c.enabled || !c.idleReminder) return
    await send($, idlePing(c.language, session.project), false)
  } catch (error) {
    debug($, `idle ping failed (${errorText(error)})`)
  }
}

// The tool of the one permission request pending: with none, or several (queued, parallel, or
// one already answered without a notice), the name is left out rather than guessed.
function pendingTool(now: number): string | null {
  const recent = session.requests.filter(request => now - request.at <= PENDING_REQUEST_MS)
  session.requests = []
  return recent.length === 1 ? (recent[0]?.tool ?? null) : null
}

// What a "needs your input" notice is about.
function waitingFor(type: string, message: string, now: number): WaitingWhy {
  if (type === 'agent_needs_input') return { why: 'agent' }
  if (type.startsWith('elicitation')) return { why: 'mcp' }
  if (type === 'worker_permission_prompt') return { why: 'permission' }
  if (session.openDialog !== null) return { ...session.openDialog }
  const tool = toolFromMessage(message) ?? (/permission/i.test(message) ? pendingTool(now) : null)
  if (tool === 'AskUserQuestion') return { why: 'question' }
  if (tool === 'ExitPlanMode' || /approval for the plan/i.test(message)) return { why: 'plan' }
  if (tool !== null) return { why: 'permission', tool }
  if (/permission/i.test(message)) return { why: 'permission' }
  return { why: 'other' }
}

async function onNotification($: EngineInterface, type: string, message: string): Promise<void> {
  // $.ui.notify (this mod's fallback, or any plugin's) comes back here as plugin_notification.
  if (type === 'plugin_notification') return
  if (type === 'idle_prompt') return onIdle($)
  if (!WAITING_TYPES.has(type)) return
  try {
    const now = await $.clock.now()
    const key = `${type}\n${message}`
    // Claude Code raises one notice per dialog; this only drops an exact repeat of the same one.
    if (session.lastNotice !== null && session.lastNotice.key === key && now - session.lastNotice.at < SAME_NOTICE_MS) return
    session.lastNotice = { key, at: now }
    await onWaiting($, waitingFor(type, message, now))
  } catch (error) {
    debug($, `notice not handled (${errorText(error)})`)
  }
}

function questionOf(e: unknown): string | undefined {
  const questions = (e as { questions?: unknown }).questions
  if (!Array.isArray(questions) || questions.length === 0) return undefined
  const first = questions[0] as { question?: unknown } | undefined
  return typeof first?.question === 'string' ? first.question : undefined
}

// A question or plan dialog is open while its tool call runs, and the call ends when you answer:
// that moment is an interaction.
async function watchDialog<R>($: EngineInterface, dialog: OpenDialog, run: () => Promise<R>): Promise<R> {
  session.openDialog = dialog
  try {
    return await run()
  } finally {
    if (session.openDialog === dialog) session.openDialog = null
    try {
      session.turnInteractionAt = await $.clock.now()
    } catch {
      // the done ping keeps measuring from the turn's start
    }
  }
}

async function setOverride($: EngineInterface, field: OverrideField, value: unknown): Promise<void> {
  // Read, change one field, write: another session's choices stay.
  const stored = readOverrides(await $.store.get(STORE_KEY))
  if (value === session.base[field]) delete stored[field]
  else stored[field] = { value, base: session.base[field] }
  const { config, kept } = applyOverrides(session.base, stored)
  session.config = config
  session.overrides = kept
  await $.store.set(STORE_KEY, kept)
}

const EVENT_WORDS: Record<string, Events> = {
  done: 'done',
  'terminé': 'done',
  termine: 'done',
  waiting: 'waiting',
  attente: 'waiting',
  both: 'both',
  tout: 'both',
  'les deux': 'both',
}

function deliveryOf(words: string): Delivery | null {
  const joined = words.replace(/\bson\b/g, 'sound').replace(/\s*(\+|and|et|&)\s*|\s+/g, '+')
  if (joined === 'sound+popup') return 'popup+sound'
  return (DELIVERIES as readonly string[]).includes(joined) ? (joined as Delivery) : null
}

async function runCommand($: EngineInterface, args: string): Promise<{ text: string }> {
  await ensureStarted($)
  await refreshOverrides($)
  const joined = args.trim().toLowerCase().replace(/\s+/g, ' ')
  const words = joined === '' ? [] : joined.split(' ')
  const c = () => session.config
  const fr = () => session.config.language === 'fr'
  const platform = await platformOf($)

  if (words.length === 0 || joined === 'status') {
    const last = session.last === null ? null : describeOutcome(session.last, c(), platform)
    return { text: statusText(c(), session.overrides, platform, PLATFORM_LABEL[platform], last) }
  }
  if (joined === 'help' || joined === 'aide') return { text: helpText(c().language) }
  if (joined === 'on' || joined === 'off') {
    await setOverride($, 'enabled', joined === 'on')
    return {
      text: c().enabled
        ? fr() ? 'done-waiting-ping est activé.' : 'done-waiting-ping is on.'
        : fr() ? 'done-waiting-ping est coupé (/ping on pour le réactiver).' : 'done-waiting-ping is off (/ping on turns it back on).',
    }
  }
  const events = EVENT_WORDS[joined]
  if (events !== undefined && (EVENTS as readonly string[]).includes(events)) {
    await setOverride($, 'events', events)
    return { text: fr() ? `Notifie maintenant : ${eventsLabel(c())}.` : `Now pinging: ${eventsLabel(c())}.` }
  }
  const delivery = deliveryOf(joined)
  if (delivery !== null) {
    await setOverride($, 'delivery', delivery)
    return { text: fr() ? `Envoi : ${deliveryLabel(c())}.` : `Delivery: ${deliveryLabel(c())}.` }
  }
  if (words[0] === 'test') {
    const kind = words[1] === 'waiting' || words[1] === 'attente' ? 'waiting' : 'done'
    const ping =
      kind === 'done'
        ? donePing(c().language, session.project, 'answer', 252_000)
        : waitingPing(c().language, session.project, { why: 'permission', tool: 'Bash' }, c().showDetails)
    const outcome = await send($, ping, true)
    return { text: describeOutcome(outcome, c(), platform) }
  }
  if (joined === 'reset') {
    await $.store.set(STORE_KEY, {})
    session.overrides = {}
    session.config = applyOverrides(session.base, {}).config
    return { text: fr() ? 'Retour aux réglages de /config.' : 'Back to your /config settings.' }
  }
  const secondsValue = parseDuration(joined)
  if (secondsValue !== null) {
    await setOverride($, 'doneAfterSeconds', secondsValue)
    const shown = duration(c().doneAfterSeconds * 1000, c().language)
    return {
      text: fr()
        ? `Ping « terminé » quand un tour finit après ${shown} sans interaction.`
        : `Done ping when a turn ends ${shown} or more after you last interacted.`,
    }
  }
  return { text: `${fr() ? `Commande inconnue : ${joined}` : `Unknown command: ${joined}`}\n${helpText(c().language)}` }
}

export const register: Register = (on, options) => {
  session = freshSession(fromOptions(options))

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    session.isInteractive = e.isInteractive
    await ensureStarted($, e.cwd)
    return result
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) session.turnInteractionAt = null
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    // Read now: a next turn may start (and reset it) before the done ping is decided.
    const interactionAt = session.turnInteractionAt
    const result = await next(e)
    if (e.agentId === undefined) void onDone($, e.durationMs, e.isAborted, e.reason, interactionAt)
    return result
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) =>
    watchDialog($, { why: 'question', question: questionOf(e) }, () => next(e)),
  ).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => watchDialog($, { why: 'plan' }, () => next(e))).catch(($, e, next) =>
    next(e),
  )

  on('classic.PermissionRequest', async ($, e, next) => {
    if (typeof e.tool_name === 'string') {
      const now = await $.clock.now()
      session.requests = [...session.requests.filter(request => now - request.at <= PENDING_REQUEST_MS), { tool: e.tool_name, at: now }]
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    // Handled before the hooks beneath run: a slow settings Notification hook must not delay it.
    void onNotification($, String(e.notification_type ?? ''), String(e.message ?? ''))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, async ($, e) => runCommand($, e.args ?? '')).catch(() => ({
    text: 'done-waiting-ping: the command failed (see claude --debug).',
  }))
}

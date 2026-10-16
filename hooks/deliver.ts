import type { EngineInterface, ProcessRunResult } from 'claude-code'
import type { SoundChoice } from './config'
import type { Ping } from './text'

// How a ping reaches the person, per operating system. Every program runs as an argument
// vector (no shell), and the text never becomes part of a script:
//   Windows (and WSL): Windows PowerShell 5.1 runs the bundled scripts/notify-windows.ps1,
//                      the request passed in the DWP_PAYLOAD environment variable.
//   macOS:             osascript `display notification`, the text passed as argv items; afplay.
//   Linux:             notify-send; canberra-gtk-play, paplay, pw-play or aplay.
// Over SSH (macOS, Linux) the remote desktop is not where the person is, so Claude Code's own
// terminal notification ($.ui.notify) is used; it is also the fallback when the system fails.

export type Platform = 'windows' | 'wsl' | 'macos' | 'linux' | 'unknown'

export type Request = {
  ping: Ping
  popup: boolean
  sound: SoundChoice
  soundFile: string
  // Stay quiet while the terminal (macOS: the app Claude Code runs in) or a listed app has the
  // focus. Windows matches process names (WindowsTerminal, Code), macOS bundle ids; not Linux.
  quietWhenFocused: boolean
  quietApps: readonly string[]
}

// Why an outcome is what it is; text.ts words each one for the person.
export type Reason =
  | 'ok'
  | 'ok-sound-fallback'
  | 'ok-sound-failed'
  | 'ok-unconfirmed'
  | 'ok-scheme-silent'
  | 'nothing-to-do'
  | 'focus'
  | 'headless'
  | 'ssh'
  | 'toast-off-app'
  | 'toast-off-all'
  | 'toast-off-policy'
  | 'toast-dropped'
  | 'cannot-start'
  | 'script-error'
  | 'popup-failed'
  | 'sound-failed'
  | 'unsupported-system'

export type Outcome = {
  status: 'sent' | 'skipped' | 'fallback' | 'failed'
  via: string
  reason: Reason
  detail: string
  ms: number
}

type Attempt = { ok: boolean; skipped?: boolean; via: string; reason: Reason; detail: string }

// Generous: delivery runs after the hook has returned, and a busy machine can stall a cold
// PowerShell start; killing it after the toast showed would add a duplicate fallback.
const POPUP_TIMEOUT_MS = 60_000
const SOUND_TIMEOUT_MS = 30_000
const SOUND_MAX_SECONDS = '20'
const PROBE_TIMEOUT_MS = 5_000
const TOAST_EXPIRE_MINUTES = 120
const ATTRIBUTION = 'Claude Code'
const GROUP = 'done-waiting-ping'

const WINDOWS_EVENT = { default: 'Default', message: 'IM', mail: 'Mail', reminder: 'Reminder' } as const
const MAC_SOUND = { default: 'Glass', message: 'Ping', mail: 'Pop', reminder: 'Hero' } as const
const LINUX_SOUND = { default: 'complete', message: 'message-new-instant', mail: 'message', reminder: 'bell' } as const
const LINUX_SOUND_DIR = '/usr/share/sounds/freedesktop/stereo'
const WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const OK_WORDS = new Set(['toast-ok', 'toast-unconfirmed', 'sound-ok', 'sound-fallback', 'sound-none'])

export const PLATFORM_LABEL: Record<Platform, string> = {
  windows: 'Windows (PowerShell toast)',
  wsl: 'WSL (Windows toast through powershell.exe)',
  macos: 'macOS (osascript)',
  linux: 'Linux (notify-send)',
  unknown: 'unknown (terminal notification only)',
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// `uname -sr`: "Darwin 23.5.0", "Linux 6.8.0-45-generic", "Linux 5.15.167.4-microsoft-standard-WSL2".
export function platformFromUname(text: string): Platform {
  const [name, release = ''] = text.trim().split(/\s+/)
  if (name === 'Darwin') return 'macos'
  if (name === 'Linux') return /microsoft/i.test(release) ? 'wsl' : 'linux'
  return 'unknown'
}

export async function detectPlatform($: EngineInterface): Promise<Platform> {
  if ((await $.env.get('OS')) === 'Windows_NT') return 'windows'
  if ((await $.env.get('WSL_DISTRO_NAME')) !== undefined) return 'wsl'
  try {
    const ran = await $.process.run(['uname', '-sr'], { timeoutMs: PROBE_TIMEOUT_MS })
    return platformFromUname(ran.stdout)
  } catch {
    return 'unknown'
  }
}

// ---- Windows ----

// The request as the script reads it: JSON with every non-ASCII character escaped (\uXXXX,
// which the script's JSON parser decodes, surrogate pairs included), then base64.
export function encodePayload(value: unknown): string {
  const json = JSON.stringify(value).replace(/[\u007f-\uffff]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
  return btoa(json)
}

export function decodePayload(base64: string): unknown {
  return JSON.parse(atob(base64))
}

// '' silent, an event name, or a file path. A custom file that is not a .wav falls back to the
// default event (Windows plays .wav files only); the script handles a missing or unusable .wav.
export function windowsSound(req: Request, soundFile: string): { sound: string; fallback: boolean } {
  if (req.sound === 'none') return { sound: '', fallback: false }
  if (req.sound === 'custom') {
    if (soundFile === '' || !/\.wav["']?$/i.test(soundFile)) return { sound: WINDOWS_EVENT.default, fallback: true }
    return { sound: soundFile, fallback: false }
  }
  return { sound: WINDOWS_EVENT[req.sound], fallback: false }
}

// U+FFFE and U+FFFF are not valid in XML, and Windows PowerShell's JSON parser mangles them.
const noNonCharacters = (text: string) => text.replace(/[￾￿]/g, '')

export function windowsPayload(req: Request, sound: string): Record<string, unknown> {
  return {
    title: noNonCharacters(req.ping.title),
    body: noNonCharacters(req.ping.body),
    attribution: ATTRIBUTION,
    popup: req.popup,
    sound,
    tag: req.ping.tag,
    group: GROUP,
    expireMinutes: TOAST_EXPIRE_MINUTES,
    quietWhenForeground: req.quietWhenFocused ? [...req.quietApps] : [],
  }
}

export function wslEnv(inherited: string | undefined): string {
  const kept = (inherited ?? '').split(':').filter(entry => entry !== '' && entry.split('/')[0] !== 'DWP_PAYLOAD')
  return [...kept, 'DWP_PAYLOAD'].join(':')
}

function droppedReason(setting: string): Reason {
  if (setting === 'DisabledForApplication') return 'toast-off-app'
  if (setting === 'DisabledForUser') return 'toast-off-all'
  if (setting === 'DisabledByGroupPolicy' || setting === 'DisabledByManifest') return 'toast-off-policy'
  return 'toast-dropped'
}

// The script's first word says what happened. Exit 0 without a known word is not a success:
// under WSL a PowerShell that could not run the script can still exit 0.
export function readWindowsResult(ran: ProcessRunResult): Attempt {
  const out = ran.stdout.trim()
  const words = out.split(/\s+/)
  const first = words[0] ?? ''
  if (first === 'skipped-foreground') return { ok: false, skipped: true, via: 'windows-toast', reason: 'focus', detail: out }
  if (first === 'toast-dropped') {
    const setting = /setting=(\S*)/.exec(out)?.[1] ?? ''
    return { ok: false, via: 'windows-toast', reason: droppedReason(setting), detail: out }
  }
  if (ran.exitCode === 0 && OK_WORDS.has(first)) {
    const reason: Reason = words.includes('sound-failed')
      ? 'ok-sound-failed'
      : words.includes('sound-fallback')
        ? 'ok-sound-fallback'
        : first === 'toast-unconfirmed'
          ? 'ok-unconfirmed'
          : words.includes('sound-none')
            ? 'ok-scheme-silent'
            : 'ok'
    return { ok: true, via: 'windows-toast', reason, detail: out }
  }
  if (first === 'sound-failed') return { ok: false, via: 'windows-toast', reason: 'sound-failed', detail: out }
  const why = out || ran.stderr.trim().slice(0, 200)
  return { ok: false, via: 'windows-toast', reason: 'script-error', detail: `exit ${ran.exitCode}: ${why}` }
}

// Under WSL, powershell.exe is wherever the automount root puts drive C, else on the PATH.
async function wslPowershells($: EngineInterface): Promise<string[]> {
  const found: string[] = []
  try {
    const ran = await $.process.run(['wslpath', '-u', WINDOWS_POWERSHELL], { timeoutMs: PROBE_TIMEOUT_MS })
    const path = ran.stdout.trim()
    if (ran.exitCode === 0 && path !== '') found.push(path)
  } catch {
    // no wslpath: try the PATH
  }
  return [...found, 'powershell.exe']
}

async function wslWindowsPath($: EngineInterface, path: string): Promise<string | null> {
  try {
    const ran = await $.process.run(['wslpath', '-w', path], { timeoutMs: PROBE_TIMEOUT_MS })
    const converted = ran.stdout.trim()
    return ran.exitCode === 0 && converted !== '' ? converted : null
  } catch {
    return null
  }
}

async function windowsDelivery($: EngineInterface, req: Request, wsl: boolean): Promise<Attempt> {
  let powershells: string[]
  let script: string
  let soundFile = req.soundFile
  const env: Record<string, string> = {}
  if (wsl) {
    const converted = await wslWindowsPath($, `${$.plugin.root}/scripts/notify-windows.ps1`)
    if (converted === null) return { ok: false, via: 'windows-toast', reason: 'cannot-start', detail: 'wslpath could not convert the script path' }
    script = converted
    powershells = await wslPowershells($)
    // A Linux path, or ~/..., becomes the Windows path the script can open.
    if (req.sound === 'custom' && soundFile !== '' && !/^[a-z]:[\\/]/i.test(soundFile) && !soundFile.startsWith('\\\\')) {
      const home = (await $.env.get('HOME')) ?? ''
      const linuxPath = soundFile.startsWith('~/') && home !== '' ? `${home}${soundFile.slice(1)}` : soundFile
      soundFile = (await wslWindowsPath($, linuxPath)) ?? soundFile
    }
    // WSL passes a variable to a Windows program only when WSLENV names it, with no flag
    // (`/u` is the other direction, Windows to WSL: with it the variable does not cross).
    env.WSLENV = wslEnv(await $.env.get('WSLENV'))
  } else {
    const systemRoot = (await $.env.get('SystemRoot')) ?? 'C:\\Windows'
    powershells = [`${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`]
    script = `${$.plugin.root}\\scripts\\notify-windows.ps1`
  }
  const { sound } = windowsSound(req, soundFile)
  env.DWP_PAYLOAD = encodePayload(windowsPayload(req, sound))
  let lastError = ''
  for (const powershell of powershells) {
    const argv = [powershell, '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script]
    try {
      const attempt = readWindowsResult(await $.process.run(argv, { env, timeoutMs: POPUP_TIMEOUT_MS }))
      return req.sound === 'custom' && windowsSound(req, soundFile).fallback && attempt.reason === 'ok'
        ? { ...attempt, reason: 'ok-sound-fallback' }
        : attempt
    } catch (error) {
      lastError = errorText(error)
    }
  }
  return { ok: false, via: 'windows-toast', reason: 'cannot-start', detail: lastError }
}

// ---- macOS ----

export function osascriptArgv(title: string, body: string): string[] {
  return ['osascript', '-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title (item 2 of argv)', '-e', 'end run', body, title]
}

// `lsappinfo front` prints the front app's ASN; `lsappinfo info -only bundleid <asn>` its id.
export function asnOf(text: string): string | null {
  return /ASN:[0-9a-fx-]+:?/i.exec(text)?.[0] ?? null
}

export function bundleOf(text: string): string | null {
  return /(?:"CFBundleIdentifier"|bundleID)\s*=\s*"([^"]+)"/i.exec(text)?.[1] ?? null
}

async function macFrontBundle($: EngineInterface): Promise<string | null> {
  try {
    const front = await $.process.run(['lsappinfo', 'front'], { timeoutMs: PROBE_TIMEOUT_MS })
    const asn = asnOf(front.stdout)
    if (front.exitCode !== 0 || asn === null) return null
    const info = await $.process.run(['lsappinfo', 'info', '-only', 'bundleid', asn], { timeoutMs: PROBE_TIMEOUT_MS })
    return info.exitCode === 0 ? bundleOf(info.stdout) : null
  } catch {
    return null
  }
}

// Tries each player in turn until one works. A player killed at the timeout did play (a long
// sound), so the next one is not started to play it again.
async function playFirst($: EngineInterface, players: readonly string[][]): Promise<boolean> {
  for (const argv of players) {
    const started = await $.clock.now()
    try {
      const ran = await $.process.run(argv, { timeoutMs: SOUND_TIMEOUT_MS })
      if (ran.exitCode === 0) return true
    } catch {
      if ((await $.clock.now()) - started >= SOUND_TIMEOUT_MS - 1_000) return true
    }
  }
  return false
}

export function unquote(path: string): string {
  const trimmed = path.trim()
  return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed
}

// No shell expands `~/` in an argument vector: do it here (macOS, Linux).
async function homePath($: EngineInterface, path: string): Promise<string> {
  const file = unquote(path)
  if (!file.startsWith('~/')) return file
  const home = await $.env.get('HOME')
  return home === undefined || home === '' ? file : `${home}${file.slice(1)}`
}

async function macDelivery($: EngineInterface, req: Request): Promise<Attempt> {
  if (req.quietWhenFocused) {
    const front = await macFrontBundle($)
    const host = await $.env.get('__CFBundleIdentifier')
    if (front !== null && (front === host || req.quietApps.includes(front))) {
      return { ok: false, skipped: true, via: 'osascript', reason: 'focus', detail: `skipped-foreground ${front}` }
    }
  }
  // The sound plays through afplay, not the notification, so it is heard even when macOS
  // keeps notifications from Script Editor (osascript's sender) hidden.
  const soundPath =
    req.sound === 'none'
      ? null
      : req.sound === 'custom'
        ? (await homePath($, req.soundFile)) || `/System/Library/Sounds/${MAC_SOUND.default}.aiff`
        : `/System/Library/Sounds/${MAC_SOUND[req.sound]}.aiff`
  let shown = false
  if (req.popup) {
    try {
      shown = (await $.process.run(osascriptArgv(req.ping.title, req.ping.body), { timeoutMs: POPUP_TIMEOUT_MS })).exitCode === 0
    } catch {
      shown = false
    }
  }
  const played = soundPath === null ? false : await playFirst($, [['afplay', '-t', SOUND_MAX_SECONDS, soundPath]])
  if (req.popup) {
    if (!shown) return { ok: false, via: 'osascript', reason: 'popup-failed', detail: 'osascript failed' }
    return { ok: true, via: 'osascript', reason: soundPath !== null && !played ? 'ok-sound-failed' : 'ok', detail: 'ok' }
  }
  return played ? { ok: true, via: 'afplay', reason: 'ok', detail: 'sound ok' } : { ok: false, via: 'afplay', reason: 'sound-failed', detail: 'afplay failed' }
}

// ---- Linux ----

// notify-send reads C escapes (\n, \t) in its arguments, and some daemons read the body as markup.
export function forNotifySend(text: string, markup: boolean): string {
  const escaped = markup ? text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : text
  return escaped.replace(/\\/g, '\\\\')
}

export function notifySendArgv(title: string, body: string): string[] {
  return ['notify-send', '-a', ATTRIBUTION, '-u', 'normal', '--', forNotifySend(title, false), forNotifySend(body, true)]
}

// A theme sound by id (canberra resolves the user's theme), then the freedesktop file; a custom
// file through each player that can read it.
export function linuxPlayers(sound: SoundChoice, soundFile: string): string[][] {
  if (sound === 'none') return []
  const file = sound === 'custom' ? unquote(soundFile) : ''
  if (file !== '') {
    const players = [['paplay', file], ['pw-play', file], ['canberra-gtk-play', '-f', file]]
    return /\.wav$/i.test(file) ? [...players, ['aplay', '-q', file]] : players
  }
  const id = sound === 'custom' ? LINUX_SOUND.default : LINUX_SOUND[sound]
  const themed = `${LINUX_SOUND_DIR}/${id}.oga`
  return [['canberra-gtk-play', '-i', id], ['paplay', themed], ['pw-play', themed]]
}

async function linuxDelivery($: EngineInterface, req: Request): Promise<Attempt> {
  let shown = false
  if (req.popup) {
    try {
      shown = (await $.process.run(notifySendArgv(req.ping.title, req.ping.body), { timeoutMs: POPUP_TIMEOUT_MS })).exitCode === 0
    } catch {
      shown = false
    }
  }
  const players = linuxPlayers(req.sound, req.sound === 'custom' ? await homePath($, req.soundFile) : '')
  const played = players.length > 0 && (await playFirst($, players))
  if (req.popup) {
    if (!shown) return { ok: false, via: 'notify-send', reason: 'popup-failed', detail: 'notify-send failed' }
    return { ok: true, via: 'notify-send', reason: players.length > 0 && !played ? 'ok-sound-failed' : 'ok', detail: 'ok' }
  }
  return played ? { ok: true, via: 'sound', reason: 'ok', detail: 'sound ok' } : { ok: false, via: 'sound', reason: 'sound-failed', detail: 'no sound player worked' }
}

// ---- all platforms ----

async function terminal($: EngineInterface, ping: Ping): Promise<{ sent: boolean; via: string; why: string }> {
  try {
    const result = await $.ui.notify(ping.body, { title: ping.title })
    if (result.isSent) return { sent: true, via: `terminal (${result.channel})`, why: '' }
    return { sent: false, via: 'terminal', why: `terminal notification not sent (${result.reason})` }
  } catch (error) {
    return { sent: false, via: 'terminal', why: errorText(error) }
  }
}

async function onSsh($: EngineInterface): Promise<boolean> {
  return (await $.env.get('SSH_CONNECTION')) !== undefined || (await $.env.get('SSH_TTY')) !== undefined
}

export async function deliver($: EngineInterface, platform: Platform, req: Request): Promise<Outcome> {
  const started = await $.clock.now()
  const done = async (status: Outcome['status'], via: string, reason: Reason, detail: string): Promise<Outcome> => ({
    status,
    via,
    reason,
    detail,
    ms: (await $.clock.now()) - started,
  })
  if (!req.popup && req.sound === 'none') return done('skipped', 'none', 'nothing-to-do', 'sound only, and the sound is none')
  if ((platform === 'macos' || platform === 'linux') && (await onSsh($))) {
    const sent = await terminal($, req.ping)
    return done(sent.sent ? 'sent' : 'failed', sent.via, 'ssh', sent.why || 'over SSH: terminal notification')
  }
  let attempt: Attempt
  try {
    if (platform === 'windows' || platform === 'wsl') attempt = await windowsDelivery($, req, platform === 'wsl')
    else if (platform === 'macos') attempt = await macDelivery($, req)
    else if (platform === 'linux') attempt = await linuxDelivery($, req)
    else attempt = { ok: false, via: 'none', reason: 'unsupported-system', detail: 'no notifier for this system' }
  } catch (error) {
    attempt = { ok: false, via: platform, reason: 'cannot-start', detail: errorText(error) }
  }
  if (attempt.skipped === true) return done('skipped', attempt.via, attempt.reason, attempt.detail)
  if (attempt.ok) return done('sent', attempt.via, attempt.reason, attempt.detail)
  const sent = await terminal($, req.ping)
  const detail = sent.why === '' ? `${attempt.via}: ${attempt.detail}` : `${attempt.via}: ${attempt.detail}; ${sent.why}`
  return done(sent.sent ? 'fallback' : 'failed', sent.sent ? sent.via : attempt.via, attempt.reason, detail)
}

import { mock } from 'claude-code/testing'

// The engine beneath the mod, faked: every op and event the mod touches has a bottom hook
// here, and each records what the mod asked of it.

export type Os = 'windows' | 'wsl' | 'macos' | 'linux' | 'freebsd'
export type RunResult = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }
export type Run = { argv: string[]; env: Record<string, string> | undefined }

export type World = {
  os: Os
  runs: Run[]
  notes: Array<{ text: string; title?: string }>
  logs: string[]
  commands: string[]
  store: Map<string, unknown>
  clock: ReturnType<typeof mock.clock>
  // null: $.session.surfaces() fails.
  surfaces: string[] | null
  // How long a tool call takes beneath the mod (a dialog waiting for an answer), and whether
  // it then fails (the call interrupted).
  dialogMs: number
  callFails: boolean
  callThrows: boolean
  // How long the hooks beneath take to answer a notice (a slow settings Notification hook).
  noticeHookMs: number
  // How long a program runs before answering, by argv.
  runMs: (argv: string[]) => number
  notifySent: boolean
  answer: (argv: string[]) => RunResult | Error
}

export const result = (stdout = '', exitCode = 0): RunResult => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

const ENV: Record<Os, Record<string, string>> = {
  windows: { OS: 'Windows_NT', SystemRoot: 'C:\\Windows', CLAUDE_CODE_ENTRYPOINT: 'cli' },
  wsl: { WSL_DISTRO_NAME: 'Ubuntu-24.04', WSLENV: 'WT_SESSION:WT_PROFILE_ID/', HOME: '/home/me', CLAUDE_CODE_ENTRYPOINT: 'cli' },
  macos: { __CFBundleIdentifier: 'com.apple.Terminal', HOME: '/Users/me', CLAUDE_CODE_ENTRYPOINT: 'cli' },
  linux: { HOME: '/home/me', CLAUDE_CODE_ENTRYPOINT: 'cli' },
  freebsd: { CLAUDE_CODE_ENTRYPOINT: 'cli' },
}

export const ROOT: Record<Os, string> = {
  windows: 'C:\\work\\shop',
  wsl: '/home/me/shop',
  macos: '/Users/me/shop',
  linux: '/home/me/shop',
  freebsd: '/home/me/shop',
}

export const UNSET = '<unset>'

export const WSL_SCRIPT = 'C:\\Users\\me\\plugin\\scripts\\notify-windows.ps1'
export const WSL_POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

const UNAME: Record<Os, string> = {
  windows: '',
  wsl: 'Linux 5.15.167.4-microsoft-standard-WSL2\n',
  macos: 'Darwin 23.5.0\n',
  linux: 'Linux 6.8.0-45-generic\n',
  freebsd: 'FreeBSD 14.1-RELEASE\n',
}

export function defaultAnswer(os: Os): (argv: string[]) => RunResult | Error {
  return argv => {
    if (argv[0] === 'uname') return result(UNAME[os])
    if (argv[0] === 'wslpath' && argv[1] === '-u') return result(`${WSL_POWERSHELL}\n`)
    if (argv[0] === 'wslpath') return argv[2]?.endsWith('notify-windows.ps1') ? result(`${WSL_SCRIPT}\n`) : result(`\\\\wsl.localhost\\Ubuntu-24.04${(argv[2] ?? '').replace(/\//g, '\\')}\n`)
    if ((argv[0] ?? '').endsWith('powershell.exe')) return result('toast-ok')
    return result('')
  }
}

export function setup(on: any, os: Os = 'windows', over: Partial<World> = {}, env: Record<string, string> = {}): World {
  const world: World = {
    os,
    runs: [],
    notes: [],
    logs: [],
    commands: [],
    store: new Map(),
    clock: mock.clock(on, { now: 1_000_000 }),
    surfaces: ['terminal'],
    dialogMs: 0,
    callFails: false,
    callThrows: false,
    noticeHookMs: 0,
    runMs: () => 0,
    notifySent: true,
    answer: defaultAnswer(os),
    ...over,
  }
  // A value of UNSET removes the variable.
  const variables: Record<string, string> = { ...ENV[os], ...env }
  for (const name of Object.keys(variables)) if (variables[name] === UNSET) delete variables[name]
  mock.env(on, variables)
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT[os] }))
  on('session.cwd', () => ({ value: ROOT[os] }))
  on('session.surfaces', () => (world.surfaces === null ? { deny: 'no surfaces here' } : { value: world.surfaces }))
  on('store.get', ($: any, e: any) => ({ value: world.store.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    world.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', ($: any, e: any) => {
    world.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.log', ($: any, e: any) => {
    world.logs.push(String(e.text))
    return { value: undefined }
  })
  on('ui.notify', ($: any, e: any) => {
    world.notes.push({ text: e.text, title: e.title ?? e.options?.title })
    return { value: world.notifySent ? { isSent: true, channel: 'terminal_bell' } : { isSent: false, reason: 'no-channel' } }
  })
  on('process.run', async ($: any, e: any) => {
    world.runs.push({ argv: [...e.argv], env: e.init?.env })
    const ms = world.runMs([...e.argv])
    if (ms > 0) await world.clock.sleep(ms)
    const answer = world.answer([...e.argv])
    // A refusal makes $.process.run reject, as a program that cannot start does.
    if (answer instanceof Error) return { deny: answer.message }
    return { value: answer }
  })
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  on('tool.call', async ($: any, e: any) => {
    await world.clock.sleep(world.dialogMs)
    // The call refused beneath the mod, as an interrupted dialog is; or failing outright.
    if (world.callFails) return { deny: 'interrupted' }
    if (world.callThrows) throw new Error('interrupted')
    return { result: { answers: {} } }
  })
  on('classic.Notification', async () => {
    if (world.noticeHookMs > 0) await world.clock.sleep(world.noticeHookMs)
    return {}
  })
  on('classic.PermissionRequest', () => ({}))
  return world
}

export async function start($: any, world: World, isInteractive = true): Promise<void> {
  await $.session.start({ surface: isInteractive ? 'terminal' : null, isInteractive, cwd: ROOT[world.os] })
}

// The notifications the mod asked the system for (uname, wslpath and focus probes left out).
export function pings(world: World): Run[] {
  return world.runs.filter(run => !['uname', 'wslpath', 'lsappinfo'].includes(run.argv[0] ?? ''))
}

export function at<T>(list: readonly T[], index: number): T {
  const item = list[index]
  if (item === undefined) throw new Error(`expected an item at ${index}, got ${list.length}`)
  return item
}

export function pingAt(world: World, index: number): Run {
  return at(pings(world), index)
}

// The request as the Windows script reads it. The script decodes the bytes as UTF-8, so the
// wire format must be plain ASCII: a byte above 0x7F here would be garbled on screen.
export function payloadOf(run: Run): Record<string, any> {
  const encoded = run.env?.DWP_PAYLOAD
  if (encoded === undefined) throw new Error(`no DWP_PAYLOAD in ${run.argv.join(' ')}`)
  const json = atob(encoded)
  if (!/^[\x00-\x7f]*$/.test(json)) throw new Error('DWP_PAYLOAD carries non-ASCII bytes')
  return JSON.parse(json) as Record<string, any>
}

export function payloadAt(world: World, index: number): Record<string, any> {
  return payloadOf(pingAt(world, index))
}

export function payloads(world: World): Array<Record<string, any>> {
  return pings(world).map(payloadOf)
}

export function turnEnd(durationMs: number, extra: Record<string, unknown> = {}): any {
  return { answer: 'ok', durationMs, isAborted: false, turnId: 't1', reason: 'answer', ...extra }
}

export async function longTurn($: any, world: World, durationMs = 75_000, extra: Record<string, unknown> = {}): Promise<void> {
  await $.turn.start({ text: 'go', turnId: 't1', ...('agentId' in extra ? { agentId: extra.agentId } : {}) })
  await $.turn.complete(turnEnd(durationMs, extra))
  await world.clock.settle()
}

export function notice(type: string, message: string) {
  return { hook_event_name: 'Notification', session_id: 's1', transcript_path: '/t.jsonl', cwd: '/work/shop', notification_type: type, message }
}

export async function raise($: any, world: World, type: string, message: string): Promise<void> {
  await $.classic.Notification(notice(type, message))
  await world.clock.settle()
}

export async function permissionRequest($: any, tool: string): Promise<void> {
  await $.classic.PermissionRequest({
    hook_event_name: 'PermissionRequest',
    session_id: 's1',
    transcript_path: '/t.jsonl',
    cwd: '/work/shop',
    tool_name: tool,
    tool_input: {},
  })
}

// The terminal's wording (Claude Code 2.1.301 REPL) and the SDK/desktop hosts' wording.
export const TERMINAL_PERMISSION = 'Claude needs your permission'
export const TERMINAL_PLAN = 'Claude Code needs your approval for the plan'
export const sdkPermission = (tool: string) => `Claude needs your permission to use ${tool}`

export const run = (args: string) =>
  ({ command: 'ping', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }) as any

export function question(text: string, id = 'q1') {
  return {
    tool: 'AskUserQuestion',
    tool_use_id: id,
    questions: [{ question: text, header: 'Pick', multiSelect: false, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }],
  }
}

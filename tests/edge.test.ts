import { describe, expect, test } from 'claude-code/testing'
import {
  longTurn,
  notice,
  payloadAt,
  payloads,
  permissionRequest,
  pingAt,
  pings,
  question,
  raise,
  result,
  run,
  sdkPermission,
  setup,
  start,
  TERMINAL_PERMISSION,
  turnEnd,
} from './world'

describe('done: when you were last there', () => {
  test('approving a plan counts as being there', { options: { events: 'done' } }, async ($, on) => {
    const world = setup(on, 'windows', { dialogMs: 50_000 })
    await start($, world)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const plan = $.tool.call({ tool: 'ExitPlanMode', tool_use_id: 'p1', plan: '# Plan' } as any)
    await world.clock.advance(50_000)
    await plan
    await world.clock.advance(20_000)
    await $.turn.complete(turnEnd(70_000))
    await world.clock.settle()
    expect(pings(world)).toHaveLength(0)
  })

  test('a new turn starts the clock again: short turns stay quiet, long ones ping', { options: { events: 'done' } }, async ($, on) => {
    const world = setup(on, 'windows', { dialogMs: 10_000 })
    await start($, world)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const asked = $.tool.call(question('Which?') as any)
    await world.clock.advance(10_000)
    await asked
    await $.turn.complete(turnEnd(12_000))
    await world.clock.settle()
    // Long before this turn, an answer: the new turn is measured from its own start.
    await world.clock.advance(300_000)
    await longTurn($, world, 30_000)
    expect(pings(world)).toHaveLength(0)
    await longTurn($, world, 90_000)
    expect(pings(world)).toHaveLength(1)
  })

  test('the answer is read when the turn ends, even if the next turn starts at once', { options: { events: 'done' } }, async ($, on) => {
    const world = setup(on, 'windows', { dialogMs: 50_000 })
    await start($, world)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const asked = $.tool.call(question('Which?') as any)
    await world.clock.advance(50_000)
    await asked
    await world.clock.advance(20_000)
    // A queued prompt starts the next turn before the done ping is decided.
    await $.turn.complete(turnEnd(70_000))
    await $.turn.start({ text: 'queued', turnId: 't2' })
    await world.clock.settle()
    expect(pings(world)).toHaveLength(0)
  })
})

describe('waiting: details', () => {
  test('the ping goes out before slow Notification hooks beneath have answered', async ($, on) => {
    const world = setup(on, 'windows', { noticeHookMs: 30_000 })
    await start($, world)
    const raised = $.classic.Notification(notice('permission_prompt', TERMINAL_PERMISSION))
    await world.clock.settle()
    expect(pings(world)).toHaveLength(1)
    await world.clock.advance(30_000)
    await raised
  })

  test('two pending permission requests: no tool name rather than a guess; a used name is not reused', async ($, on) => {
    const world = setup(on)
    await start($, world)
    await permissionRequest($, 'Bash')
    await permissionRequest($, 'Edit')
    await world.clock.advance(6_000)
    await raise($, world, 'permission_prompt', TERMINAL_PERMISSION)
    await world.clock.advance(10_000)
    await permissionRequest($, 'WebFetch')
    await world.clock.advance(6_000)
    await raise($, world, 'permission_prompt', TERMINAL_PERMISSION)
    await world.clock.advance(10_000)
    await raise($, world, 'permission_prompt', TERMINAL_PERMISSION)
    expect(payloads(world).map(p => p.body)).toEqual([
      'shop \u00b7 needs your permission',
      'shop \u00b7 permission needed: WebFetch',
      'shop \u00b7 needs your permission',
    ])
  })

  test("the tool named in the notice wins over the pending request", async ($, on) => {
    const world = setup(on)
    await start($, world)
    await permissionRequest($, 'Bash')
    await raise($, world, 'permission_prompt', sdkPermission('Edit'))
    expect(payloadAt(world, 0).body).toBe('shop \u00b7 permission needed: Edit')
  })

  test("a worker's prompt never takes the open question or the leader's tool", async ($, on) => {
    const world = setup(on, 'windows', { dialogMs: 20_000 })
    await start($, world)
    await permissionRequest($, 'Bash')
    const asked = $.tool.call(question('Main question?') as any)
    await world.clock.advance(6_000)
    await raise($, world, 'worker_permission_prompt', 'researcher needs permission')
    await raise($, world, 'worker_permission_prompt', 'writer needs permission')
    await world.clock.advance(14_000)
    await asked
    expect(payloads(world).map(p => p.body)).toEqual(['shop \u00b7 needs your permission', 'shop \u00b7 needs your permission'])
  })

  test('an MCP request while a question is open is worded as the MCP request', async ($, on) => {
    const world = setup(on, 'windows', { dialogMs: 20_000 })
    await start($, world)
    const asked = $.tool.call(question('Main question?') as any)
    await world.clock.advance(6_000)
    await raise($, world, 'elicitation_dialog', 'Claude Code needs your input')
    await world.clock.advance(14_000)
    await asked
    expect(payloadAt(world, 0).body).toBe('shop \u00b7 an MCP server needs your input')
  })

  test('after a question call fails outright, the next notice is not taken for that question', async ($, on) => {
    const world = setup(on, 'windows', { dialogMs: 1_000, callThrows: true })
    await start($, world)
    const asked = $.tool.call(question('Gone?') as any).then(
      () => 'resolved',
      () => 'rejected',
    )
    await world.clock.advance(1_000)
    expect(await asked).toBe('rejected')
    await world.clock.advance(5_000)
    await raise($, world, 'permission_prompt', TERMINAL_PERMISSION)
    expect(payloadAt(world, 0).body).toBe('shop \u00b7 needs your permission')
  })

  test("another session's /ping off is read before a waiting ping", async ($, on) => {
    const world = setup(on)
    await start($, world)
    world.store.set('overrides', { enabled: { value: false, base: true } })
    await raise($, world, 'permission_prompt', TERMINAL_PERMISSION)
    expect(pings(world)).toHaveLength(0)
  })
})

describe('Windows details', () => {
  test('sound only: the script answering sound-ok or sound-fallback counts as sent', { options: { delivery: 'sound' } }, async ($, on) => {
    const world = setup(on, 'windows', { answer: () => result('sound-ok') })
    await start($, world)
    await longTurn($, world)
    world.answer = () => result('sound-fallback')
    await longTurn($, world)
    expect(pings(world)).toHaveLength(2)
    expect(world.notes).toHaveLength(0)
  })

  test('PowerShell comes from SystemRoot', async ($, on) => {
    const world = setup(on, 'windows', {}, { SystemRoot: 'D:\\WINDOWS' })
    await start($, world)
    await longTurn($, world)
    expect(pingAt(world, 0).argv[0]).toBe('D:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })

  test('U+FFFE and U+FFFF never reach the script', async ($, on) => {
    const world = setup(on, 'windows', { dialogMs: 10_000 })
    await start($, world)
    const asked = $.tool.call(question('Odd \uffff name \ufffe?') as any)
    await world.clock.advance(6_000)
    await raise($, world, 'permission_prompt', TERMINAL_PERMISSION)
    await world.clock.advance(4_000)
    await asked
    expect(payloadAt(world, 0).body).toBe('shop \u00b7 question: Odd name ?')
  })
})

describe('macOS and Linux details', () => {
  test('macOS: a sound that fails still counts the popup, and /ping says so', async ($, on) => {
    const world = setup(on, 'macos')
    world.answer = argv => (argv[0] === 'uname' ? result('Darwin 23.5.0\n') : argv[0] === 'afplay' ? new Error('ENOENT') : result(''))
    await start($, world)
    const text = (await $.command.run(run('test'))).text ?? ''
    expect(text).toMatch(/^Sent \(popup \+ sound, via osascript, \d+\.\d s\); no sound could be played\. If nothing appeared, allow notifications for Script Editor/)
    expect(world.notes).toHaveLength(0)
  })

  test('macOS and Linux: a ~/ custom sound path is expanded', { options: { doneSound: 'custom', doneSoundFile: '~/sounds/yay.aiff' } }, async ($, on) => {
    const world = setup(on, 'macos')
    await start($, world)
    await longTurn($, world)
    expect(pingAt(world, 1).argv).toEqual(['afplay', '-t', '20', '/Users/me/sounds/yay.aiff'])
  })

  test('Linux: a player killed at the timeout did play: the next one is not started', { options: { delivery: 'sound' } }, async ($, on) => {
    const world = setup(on, 'linux', { runMs: argv => (argv[0] === 'canberra-gtk-play' ? 30_000 : 0) })
    world.answer = argv => (argv[0] === 'uname' ? result('Linux 6.8.0-45-generic\n') : argv[0] === 'canberra-gtk-play' ? new Error('still running after 30000ms') : result(''))
    await start($, world)
    await longTurn($, world)
    await world.clock.advance(30_000)
    expect(pings(world).map(r => r.argv[0])).toEqual(['canberra-gtk-play'])
    expect(world.notes).toHaveLength(0)
  })

  test('macOS over SSH (SSH_TTY): the terminal notification', async ($, on) => {
    const world = setup(on, 'macos', {}, { SSH_TTY: '/dev/ttys003' })
    await start($, world)
    await longTurn($, world)
    expect(pings(world)).toHaveLength(0)
    expect(world.notes).toHaveLength(1)
  })

  test('over SSH, sound only with no sound still sends nothing', { options: { delivery: 'sound', doneSound: 'none' } }, async ($, on) => {
    const world = setup(on, 'linux', {}, { SSH_CONNECTION: '10.0.0.2 51000 10.0.0.9 22' })
    await start($, world)
    await longTurn($, world)
    expect(world.notes).toHaveLength(0)
  })
})

describe('French outcome texts', () => {
  test('sent, skipped and failed', { options: { language: 'fr' } }, async ($, on) => {
    const world = setup(on)
    await start($, world)
    expect((await $.command.run(run('test'))).text).toMatch(/^Envoyé \(popup \+ son, via windows-toast, \d+,\d s\)\.$/)
    world.answer = () => result('skipped-foreground WindowsTerminal', 3)
    expect((await $.command.run(run('test'))).text).toBe('Rien envoyé : une de tes applis « je regarde » était au premier plan.')
    world.answer = () => result('error COMException 0x80004005', 1)
    world.notifySent = false
    expect((await $.command.run(run('test'))).text).toMatch(/^Impossible de notifier \(le notificateur a échoué\)\. Détail : /)
  })
})

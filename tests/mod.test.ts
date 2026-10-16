import { describe, expect, test } from 'claude-code/testing'
import {
  at,
  longTurn,
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
  TERMINAL_PLAN,
  turnEnd,
  UNSET,
  WSL_POWERSHELL,
  WSL_SCRIPT,
} from './world'

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

describe('done', () => {
  test('a long main turn shows a Windows toast with its sound', async ($, on) => {
    const world = setup(on)
    await start($, world)
    await longTurn($, world, 75_000)

    const sent = pings(world)
    expect(sent).toHaveLength(1)
    const argv = at(sent, 0).argv
    expect(argv.slice(0, 8)).toEqual([POWERSHELL, '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', at(argv, 7)])
    expect(at(argv, 7).endsWith('\\scripts\\notify-windows.ps1')).toBe(true)
    expect(payloadAt(world, 0)).toMatchObject({
      title: 'Claude Code is done',
      body: 'shop \u00b7 finished in 1m 15s',
      popup: true,
      sound: 'Default',
      tag: 'done-shop',
      group: 'done-waiting-ping',
      quietWhenForeground: [],
    })
    expect(world.notes).toHaveLength(0)
    expect(world.commands).toEqual(['ping'])
  })

  test('short, interrupted and subagent turns stay silent', async ($, on) => {
    const world = setup(on)
    await start($, world)
    await longTurn($, world, 30_000)
    await longTurn($, world, 120_000, { isAborted: true, reason: 'aborted' })
    await longTurn($, world, 120_000, { agentId: 'agent-1' })
    expect(pings(world)).toHaveLength(0)
  })

  test('an error or a refusal says the turn stopped', async ($, on) => {
    const world = setup(on)
    await start($, world)
    await longTurn($, world, 120_000, { reason: 'error' })
    await longTurn($, world, 61_000, { reason: 'refusal', refusal: { category: null, explanation: null } })
    expect(payloadAt(world, 0)).toMatchObject({ title: 'Claude Code stopped', body: 'shop \u00b7 stopped on an error after 2m 00s' })
    expect(payloadAt(world, 1)).toMatchObject({ title: 'Claude Code stopped', body: 'shop \u00b7 declined the request after 1m 01s' })
  })

  test('0 seconds pings for every finished turn', { options: { doneAfterSeconds: 0 } }, async ($, on) => {
    const world = setup(on)
    await start($, world)
    await longTurn($, world, 800)
    expect(payloadAt(world, 0).body).toBe('shop \u00b7 finished in 1s')
  })

  test('answering a question counts as being there: the time since then must reach the threshold', { options: { events: 'done' } }, async ($, on) => {
    const world = setup(on, 'windows', { dialogMs: 50_000 })
    await start($, world)

    // 70 s turn, the question answered at 50 s: 20 s since you were there, under 60 s.
    await $.turn.start({ text: 'go', turnId: 't1' })
    const asked = $.tool.call(question('Which one?') as any)
    await world.clock.advance(50_000)
    await asked
    await world.clock.advance(20_000)
    await $.turn.complete(turnEnd(70_000))
    await world.clock.settle()
    expect(pings(world)).toHaveLength(0)

    // Next turn: answered at 50 s, ends at 120 s: 70 s since, so it pings.
    await $.turn.start({ text: 'go', turnId: 't2' })
    const again = $.tool.call(question('And now?', 'q2') as any)
    await world.clock.advance(50_000)
    await again
    await world.clock.advance(70_000)
    await $.turn.complete(turnEnd(120_000))
    await world.clock.settle()
    expect(payloads(world).map(p => p.title)).toEqual(['Claude Code is done'])
  })

  test('approving a permission prompt, then a long build: both the waiting and the done ping', async ($, on) => {
    // Claude Code does not tell plugins when you answer a permission prompt, so the call's end
    // (here after a 5-minute build) must not count as you being there.
    const world = setup(on, 'windows', { dialogMs: 330_000 })
    await start($, world)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const call = $.tool.call({ tool: 'Bash', tool_use_id: 'b1', command: 'npm run build' } as any)
    await world.clock.advance(6_000)
    await raise($, world, 'permission_prompt', TERMINAL_PERMISSION)
    await world.clock.advance(324_000)
    await call
    await world.clock.advance(15_000)
    await $.turn.complete(turnEnd(345_000))
    await world.clock.settle()
    expect(payloads(world).map(p => p.title)).toEqual(['Claude Code needs you', 'Claude Code is done'])
  })

  test("a subagent's turn starting mid-turn does not forget when you last interacted", { options: { events: 'done' } }, async ($, on) => {
    const world = setup(on, 'windows', { dialogMs: 50_000 })
    await start($, world)
    await $.turn.start({ text: 'go', turnId: 't1' })
    const asked = $.tool.call(question('Which one?') as any)
    await world.clock.advance(50_000)
    await asked
    await $.turn.start({ text: 'sub', turnId: 's1', agentId: 'agent-1' })
    await $.turn.complete(turnEnd(5_000, { turnId: 's1', agentId: 'agent-1' }))
    await world.clock.advance(20_000)
    await $.turn.complete(turnEnd(70_000))
    await world.clock.settle()
    expect(pings(world)).toHaveLength(0)
  })

  test('a quick tool call with no notice is not an interaction', async ($, on) => {
    const world = setup(on, 'windows', { dialogMs: 1_000 })
    await start($, world)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await world.clock.advance(60_000)
    const call = $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: 'a.ts' } as any)
    await world.clock.advance(1_000)
    await call
    await world.clock.advance(14_000)
    await $.turn.complete(turnEnd(75_000))
    await world.clock.settle()
    expect(pings(world)).toHaveLength(1)
  })
})

describe('waiting', () => {
  test("Claude Code's notice pings; the tool comes from the permission request", async ($, on) => {
    const world = setup(on)
    await start($, world)
    await permissionRequest($, 'Bash')
    await world.clock.advance(6_000)
    await raise($, world, 'permission_prompt', TERMINAL_PERMISSION)
    expect(payloadAt(world, 0)).toMatchObject({
      title: 'Claude Code needs you',
      body: 'shop \u00b7 permission needed: Bash',
      sound: 'Reminder',
      tag: 'waiting-shop',
    })
  })

  test('the terminal notice without a recent permission request has no tool name; the SDK wording names it', async ($, on) => {
    const world = setup(on)
    await start($, world)
    await permissionRequest($, 'Bash')
    await world.clock.advance(200_000)
    await raise($, world, 'permission_prompt', TERMINAL_PERMISSION)
    await world.clock.advance(10_000)
    await raise($, world, 'permission_prompt', sdkPermission('Edit'))
    expect(payloads(world).map(p => p.body)).toEqual(['shop \u00b7 needs your permission', 'shop \u00b7 permission needed: Edit'])
  })

  test('two dialogs a few seconds apart both ping; only an exact repeat within 2 s is dropped', async ($, on) => {
    const world = setup(on)
    await start($, world)
    await raise($, world, 'permission_prompt', TERMINAL_PERMISSION)
    await world.clock.advance(1_000)
    await raise($, world, 'permission_prompt', TERMINAL_PERMISSION)
    expect(pings(world)).toHaveLength(1)
    await world.clock.advance(8_000)
    await raise($, world, 'permission_prompt', TERMINAL_PERMISSION)
    expect(pings(world)).toHaveLength(2)
  })

  test("a notice while a question is open is worded as the question, first line only", async ($, on) => {
    const world = setup(on, 'windows', { dialogMs: 20_000 })
    await start($, world)
    const asked = $.tool.call(question('Should I delete **test_data.json** or `rm -rf build`?\nSecond line: password hunter2') as any)
    await world.clock.advance(6_000)
    await raise($, world, 'permission_prompt', TERMINAL_PERMISSION)
    await world.clock.advance(14_000)
    await asked
    expect(payloadAt(world, 0).body).toBe('shop \u00b7 question: Should I delete test_data.json or ?')
  })

  test('nothing pings for a question answered before Claude Code raises its notice', async ($, on) => {
    const world = setup(on, 'windows', { dialogMs: 3_000 })
    await start($, world)
    const asked = $.tool.call(question('Quick one?') as any)
    await world.clock.advance(3_000)
    await asked
    await world.clock.advance(30_000)
    expect(pings(world)).toHaveLength(0)
  })

  test('a plan waiting for approval is worded as a plan, open or not', async ($, on) => {
    const world = setup(on, 'windows', { dialogMs: 8_000 })
    await start($, world)
    const plan = $.tool.call({ tool: 'ExitPlanMode', tool_use_id: 'p1', plan: '# Plan' } as any)
    await world.clock.advance(6_000)
    await raise($, world, 'permission_prompt', TERMINAL_PLAN)
    await world.clock.advance(2_000)
    await plan
    await world.clock.advance(10_000)
    await raise($, world, 'permission_prompt', TERMINAL_PLAN)
    expect(payloads(world).map(p => p.body)).toEqual(['shop \u00b7 plan ready for your approval', 'shop \u00b7 plan ready for your approval'])
  })

  test('after a question call ends unanswered, the next notice is not taken for that question', async ($, on) => {
    const world = setup(on, 'windows', { dialogMs: 1_000, callFails: true })
    await start($, world)
    const asked = $.tool.call(question('Gone?') as any)
    await world.clock.advance(1_000)
    expect(await asked).toMatchObject({ deny: 'interrupted' })
    await world.clock.advance(5_000)
    await raise($, world, 'permission_prompt', TERMINAL_PERMISSION)
    expect(payloadAt(world, 0).body).toBe('shop \u00b7 needs your permission')
  })

  test('workers, MCP input, background agents and other dialogs ping with fixed wording', async ($, on) => {
    const world = setup(on)
    await start($, world)
    await raise($, world, 'worker_permission_prompt', 'researcher needs permission for Bash')
    await raise($, world, 'elicitation_url_dialog', 'Claude Code needs your input')
    await raise($, world, 'agent_needs_input', 'reviewer needs your input: approve db.internal.example.com')
    await raise($, world, 'permission_prompt', 'Session paused')
    expect(payloads(world).map(p => p.body)).toEqual([
      'shop \u00b7 needs your permission',
      'shop \u00b7 an MCP server needs your input',
      'shop \u00b7 needs your input',
      'shop \u00b7 needs your attention',
    ])
  })

  test('its own echo, auth and unknown notices are ignored; idle is off by default', async ($, on) => {
    const world = setup(on)
    await start($, world)
    await raise($, world, 'plugin_notification', 'shop · finished in 1m 15s')
    await raise($, world, 'auth_success', 'Claude Code login successful')
    await raise($, world, 'quota_auto_resume_fired', 'resumed')
    await raise($, world, 'idle_prompt', 'Claude is waiting for your input')
    expect(pings(world)).toHaveLength(0)
  })

  test('idle reminder when turned on, and /ping off silences it', { options: { idleReminder: true } }, async ($, on) => {
    const world = setup(on)
    await start($, world)
    await raise($, world, 'idle_prompt', 'Claude is waiting for your input')
    expect(payloadAt(world, 0)).toMatchObject({ title: 'Claude Code is waiting', body: 'shop \u00b7 waiting for your next message' })
    await $.command.run(run('off'))
    await raise($, world, 'idle_prompt', 'Claude is waiting for your input')
    expect(pings(world)).toHaveLength(1)
  })

  test('showDetails off hides the tool and the question', { options: { showDetails: false } }, async ($, on) => {
    const world = setup(on, 'windows', { dialogMs: 10_000 })
    await start($, world)
    await raise($, world, 'permission_prompt', sdkPermission('Bash'))
    const asked = $.tool.call(question('Secret plan?') as any)
    await world.clock.advance(6_000)
    await raise($, world, 'permission_prompt', TERMINAL_PERMISSION)
    await world.clock.advance(4_000)
    await asked
    expect(payloads(world).map(p => p.body)).toEqual(['shop \u00b7 needs your permission', 'shop \u00b7 has a question'])
  })
})

describe('choices', () => {
  test('events: done only ignores waiting', { options: { events: 'done' } }, async ($, on) => {
    const world = setup(on)
    await start($, world)
    await raise($, world, 'permission_prompt', TERMINAL_PERMISSION)
    expect(pings(world)).toHaveLength(0)
    await longTurn($, world)
    expect(pings(world)).toHaveLength(1)
  })

  test('events: waiting only ignores done', { options: { events: 'waiting' } }, async ($, on) => {
    const world = setup(on)
    await start($, world)
    await longTurn($, world)
    expect(pings(world)).toHaveLength(0)
    await raise($, world, 'permission_prompt', TERMINAL_PERMISSION)
    expect(pings(world)).toHaveLength(1)
  })

  test('off: nothing at all', { options: { enabled: false } }, async ($, on) => {
    const world = setup(on)
    await start($, world)
    await longTurn($, world)
    await raise($, world, 'permission_prompt', TERMINAL_PERMISSION)
    expect(pings(world)).toHaveLength(0)
  })

  test('delivery: popup only is a silent toast', { options: { delivery: 'popup' } }, async ($, on) => {
    const world = setup(on)
    await start($, world)
    await longTurn($, world)
    expect(payloadAt(world, 0)).toMatchObject({ popup: true, sound: '' })
  })

  test('delivery: sound only plays the sound, no popup', { options: { delivery: 'sound', doneSound: 'mail' } }, async ($, on) => {
    const world = setup(on)
    await start($, world)
    await longTurn($, world)
    expect(payloadAt(world, 0)).toMatchObject({ popup: false, sound: 'Mail' })
  })

  test('sound only with the sound set to none sends nothing, on any system', { options: { delivery: 'sound', doneSound: 'none' } }, async ($, on) => {
    const world = setup(on, 'freebsd')
    await start($, world)
    await longTurn($, world)
    expect(pings(world)).toHaveLength(0)
    expect(world.notes).toHaveLength(0)
    expect((await $.command.run(run(''))).text).toMatch(/Last ping: Nothing sent: delivery is sound only and the sound is none\./)
  })

  test(
    'a custom .wav is passed on (quotes from Copy as path removed); another format falls back to the default sound',
    { options: { doneSound: 'custom', doneSoundFile: '"D:\\sounds\\yay.wav"', waitingSound: 'custom', waitingSoundFile: 'D:\\sounds\\hey.mp3' } },
    async ($, on) => {
      const world = setup(on)
      await start($, world)
      await longTurn($, world)
      await raise($, world, 'permission_prompt', TERMINAL_PERMISSION)
      expect(payloadAt(world, 0).sound).toBe('D:\\sounds\\yay.wav')
      expect(payloadAt(world, 1).sound).toBe('Default')
      expect(world.logs.some(text => text.includes('waiting sent') && text.includes('ok-sound-fallback'))).toBe(true)
    },
  )

  test('quiet while focused sends the app list; /ping test ignores it', { options: { quietWhenFocused: true, focusApps: 'WindowsTerminal, Code' } }, async ($, on) => {
    const world = setup(on)
    await start($, world)
    await longTurn($, world)
    await $.command.run(run('test'))
    expect(payloadAt(world, 0).quietWhenForeground).toEqual(['WindowsTerminal', 'Code'])
    expect(payloadAt(world, 1).quietWhenForeground).toEqual([])
  })

  test('headless runs (claude -p, SDK hosts) never ping, but /ping test still does', async ($, on) => {
    const world = setup(on, 'windows', { surfaces: [] }, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' })
    await start($, world, false)
    await longTurn($, world)
    await raise($, world, 'permission_prompt', TERMINAL_PERMISSION)
    expect(pings(world)).toHaveLength(0)
    await $.command.run(run('test'))
    expect(pings(world)).toHaveLength(1)
  })

  test('the VS Code extension draws no surface, yet a person is there: it pings', async ($, on) => {
    const world = setup(on, 'windows', { surfaces: [] }, { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' })
    await start($, world, false)
    await longTurn($, world)
    expect(pings(world)).toHaveLength(1)
  })

  test('an empty or unknown entrypoint is not headless', async ($, on) => {
    const world = setup(on, 'windows', { surfaces: [] }, { CLAUDE_CODE_ENTRYPOINT: '' })
    await start($, world, false)
    await longTurn($, world)
    expect(pings(world)).toHaveLength(1)
  })

  test('with no entrypoint, a non-interactive session is headless', async ($, on) => {
    const world = setup(on, 'windows', { surfaces: [] }, { CLAUDE_CODE_ENTRYPOINT: UNSET })
    await start($, world, false)
    await longTurn($, world)
    expect(pings(world)).toHaveLength(0)
  })

  test('with no entrypoint and no session start, a failing surfaces() is not taken for headless', async ($, on) => {
    const world = setup(on, 'windows', { surfaces: null }, { CLAUDE_CODE_ENTRYPOINT: UNSET })
    await longTurn($, world)
    expect(pings(world)).toHaveLength(1)
  })

  test('French', { options: { language: 'fr' } }, async ($, on) => {
    const world = setup(on)
    await start($, world)
    await longTurn($, world, 75_000)
    await raise($, world, 'permission_prompt', sdkPermission('Bash'))
    expect(payloadAt(world, 0)).toMatchObject({ title: 'Claude Code a terminé', body: 'shop \u00b7 terminé en 1 min 15 s' })
    expect(payloadAt(world, 1)).toMatchObject({ title: 'Claude Code a besoin de toi', body: 'shop \u00b7 permission requise : Bash' })
    expect((await $.command.run(run(''))).text).toMatch(/^done-waiting-ping : activé/)
    expect((await $.command.run(run('attente'))).text).toBe('Notifie maintenant : attente seulement.')
    expect((await $.command.run(run('son'))).text).toBe('Envoi : son seulement.')
  })

  test('French outcome texts', { options: { language: 'fr' } }, async ($, on) => {
    const world = setup(on, 'windows', { answer: () => result('toast-dropped setting=DisabledForApplication', 2) })
    await start($, world)
    const text = (await $.command.run(run('test'))).text ?? ''
    expect(text).toMatch(/^La notification du système a échoué \(les notifications sont coupées pour Windows PowerShell/)
    expect(text).toMatch(/la notification du terminal a été envoyée à la place/)
  })
})

describe('fallback', () => {
  test('a dropped toast falls back to the terminal notification and names the Windows setting', async ($, on) => {
    const world = setup(on, 'windows', { answer: () => result('toast-dropped setting=DisabledForUser', 2) })
    await start($, world)
    await longTurn($, world)
    expect(world.notes).toEqual([{ text: 'shop \u00b7 finished in 1m 15s', title: 'Claude Code is done' }])
    expect((await $.command.run(run(''))).text).toMatch(/turned off for all apps/)
  })

  test('a PowerShell that cannot start falls back too, and /ping says so', async ($, on) => {
    const world = setup(on, 'windows', { answer: () => new Error('ENOENT: powershell.exe not found') })
    await start($, world)
    const text = (await $.command.run(run('test'))).text ?? ''
    expect(world.notes).toHaveLength(1)
    expect(text).toMatch(/^The system notification failed \(the notifier could not start\); the terminal notification was sent instead\. Detail: windows-toast: /)
  })

  test('exit 0 without a status word is a failure (a PowerShell that could not run the script)', async ($, on) => {
    const world = setup(on, 'windows', { answer: () => result('Windows PowerShell\nThe argument to the -File parameter does not exist.', 0) })
    await start($, world)
    await longTurn($, world)
    expect(world.notes).toHaveLength(1)
  })

  test("the script's sound fallback still counts as sent, and says so", async ($, on) => {
    const world = setup(on, 'windows', { answer: () => result('toast-ok sound-fallback') })
    await start($, world)
    const text = (await $.command.run(run('test'))).text ?? ''
    expect(world.notes).toHaveLength(0)
    expect(text).toMatch(/^Sent \(popup \+ sound, via windows-toast, \d+\.\d s\); your custom sound could not be used/)
  })

  test('nothing works: the result says so', async ($, on) => {
    const world = setup(on, 'windows', { answer: () => result('error COMException 0x80004005', 1), notifySent: false })
    await start($, world)
    const text = (await $.command.run(run('test'))).text ?? ''
    expect(text).toMatch(/^Could not notify \(the notifier failed\)\. Detail: .*no-channel/)
  })

  test('skipped because a listed app has the focus: no fallback', { options: { quietWhenFocused: true } }, async ($, on) => {
    const world = setup(on, 'windows', { answer: () => result('skipped-foreground WindowsTerminal', 3) })
    await start($, world)
    await longTurn($, world)
    expect(world.notes).toHaveLength(0)
  })

  test('an unknown system uses the terminal notification', async ($, on) => {
    const world = setup(on, 'freebsd')
    await start($, world)
    await longTurn($, world)
    expect(world.notes).toHaveLength(1)
  })
})

describe('other systems', () => {
  test('macOS: osascript with the text as argv items, the sound through afplay', async ($, on) => {
    const world = setup(on, 'macos')
    await start($, world)
    await longTurn($, world)
    expect(pings(world).map(r => r.argv)).toEqual([
      ['osascript', '-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title (item 2 of argv)', '-e', 'end run', 'shop \u00b7 finished in 1m 15s', 'Claude Code is done'],
      ['afplay', '-t', '20', '/System/Library/Sounds/Glass.aiff'],
    ])
    await $.command.run(run('sound'))
    await longTurn($, world)
    expect(pingAt(world, 2).argv).toEqual(['afplay', '-t', '20', '/System/Library/Sounds/Glass.aiff'])
    expect(pings(world)).toHaveLength(3)
  })

  test('macOS: a custom sound file', { options: { doneSound: 'custom', doneSoundFile: '/Users/me/yay.aiff' } }, async ($, on) => {
    const world = setup(on, 'macos')
    await start($, world)
    await longTurn($, world)
    expect(pingAt(world, 1).argv).toEqual(['afplay', '-t', '20', '/Users/me/yay.aiff'])
  })

  test('macOS: quiet while the terminal is in front', { options: { quietWhenFocused: true } }, async ($, on) => {
    const world = setup(on, 'macos')
    world.answer = argv => {
      if (argv[0] === 'uname') return result('Darwin 23.5.0\n')
      if (argv[0] === 'lsappinfo' && argv[1] === 'front') return result('ASN:0x0-0x1d01d:\n')
      if (argv[0] === 'lsappinfo') return result('"CFBundleIdentifier"="com.apple.Terminal"\n')
      return result('')
    }
    await start($, world)
    await longTurn($, world)
    expect(pings(world)).toHaveLength(0)
    expect(world.notes).toHaveLength(0)
  })

  test('macOS: quiet while a listed app is in front', { options: { quietWhenFocused: true, focusApps: 'com.microsoft.VSCode' } }, async ($, on) => {
    const world = setup(on, 'macos')
    world.answer = argv => {
      if (argv[0] === 'uname') return result('Darwin 23.5.0\n')
      if (argv[0] === 'lsappinfo' && argv[1] === 'front') return result('ASN:0x0-0x2e02e:\n')
      if (argv[0] === 'lsappinfo') return result('"CFBundleIdentifier"="com.microsoft.VSCode"\n')
      return result('')
    }
    await start($, world)
    await longTurn($, world)
    expect(pings(world)).toHaveLength(0)
  })

  test('Linux: notify-send with escaped text, then the theme sound', async ($, on) => {
    const world = setup(on, 'linux')
    await start($, world)
    await raise($, world, 'permission_prompt', sdkPermission('<Edit>\\n'))
    expect(pings(world).map(r => r.argv)).toEqual([
      ['notify-send', '-a', 'Claude Code', '-u', 'normal', '--', 'Claude Code needs you', 'shop \u00b7 permission needed: &lt;Edit&gt;\\\\n'],
      ['canberra-gtk-play', '-i', 'bell'],
    ])
  })

  test('Linux: sound only, through the first player that works', { options: { delivery: 'sound' } }, async ($, on) => {
    const world = setup(on, 'linux')
    world.answer = argv => {
      if (argv[0] === 'uname') return result('Linux 6.8.0-45-generic\n')
      if (argv[0] === 'canberra-gtk-play') return new Error("ENOENT: Command 'canberra-gtk-play' not found")
      return result('')
    }
    await start($, world)
    await longTurn($, world)
    expect(pings(world).map(r => r.argv)).toEqual([
      ['canberra-gtk-play', '-i', 'complete'],
      ['paplay', '/usr/share/sounds/freedesktop/stereo/complete.oga'],
    ])
  })

  test('Linux over SSH: the terminal notification, not the remote desktop', async ($, on) => {
    const world = setup(on, 'linux', {}, { SSH_CONNECTION: '10.0.0.2 51000 10.0.0.9 22' })
    await start($, world)
    await longTurn($, world)
    expect(pings(world)).toHaveLength(0)
    expect(world.notes).toHaveLength(1)
  })

  test('WSL: Windows PowerShell found through wslpath, the script path from wslpath, and WSLENV', async ($, on) => {
    const world = setup(on, 'wsl')
    await start($, world)
    await longTurn($, world)
    const toast = pingAt(world, 0)
    expect(toast.argv[0]).toBe(WSL_POWERSHELL)
    expect(toast.argv[7]).toBe(WSL_SCRIPT)
    expect(toast.env?.WSLENV).toBe('WT_SESSION:WT_PROFILE_ID/:DWP_PAYLOAD')
    expect(payloadAt(world, 0).title).toBe('Claude Code is done')
  })

  test('WSL: powershell.exe on the PATH when the drive path fails', async ($, on) => {
    const world = setup(on, 'wsl')
    const base = world.answer
    world.answer = argv => (argv[0] === WSL_POWERSHELL ? new Error('ENOENT') : base(argv))
    await start($, world)
    await longTurn($, world)
    expect(pings(world).map(r => r.argv[0])).toEqual([WSL_POWERSHELL, 'powershell.exe'])
    expect(world.notes).toHaveLength(0)
  })

  test('WSL: a Linux custom sound path becomes a Windows path', { options: { doneSound: 'custom', doneSoundFile: '~/sounds/yay.wav' } }, async ($, on) => {
    const world = setup(on, 'wsl')
    await start($, world)
    await longTurn($, world)
    expect(payloadAt(world, 0).sound).toBe('\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\sounds\\yay.wav')
  })
})

describe('/ping', () => {
  test('changes settings, keeps them, and reset goes back to /config', async ($, on) => {
    const world = setup(on)
    await start($, world)
    expect((await $.command.run(run('off'))).text).toMatch(/is off/)
    await longTurn($, world)
    expect(pings(world)).toHaveLength(0)
    expect(world.store.get('overrides')).toEqual({ enabled: { value: false, base: true } })

    await $.command.run(run('on'))
    expect(world.store.get('overrides')).toEqual({})
    expect((await $.command.run(run('waiting'))).text).toBe('Now pinging: waiting only.')
    expect((await $.command.run(run('sound'))).text).toBe('Delivery: sound only.')
    expect((await $.command.run(run('popup + sound'))).text).toBe('Delivery: popup + sound.')
    expect((await $.command.run(run('2m'))).text).toBe('Done ping when a turn ends 2m 00s or more after you last interacted.')
    const status = (await $.command.run(run('status'))).text ?? ''
    expect(status).toMatch(/Events: waiting only/)
    expect(status).toMatch(/Done after: 2m 00s without interaction/)
    expect(status).toMatch(/Set with \/ping: What to ping for, Done: minimum turn length/)

    expect((await $.command.run(run('reset'))).text).toBe('Back to your /config settings.')
    expect(world.store.get('overrides')).toEqual({})
    expect((await $.command.run(run(''))).text).toMatch(/Events: done \+ waiting/)
  })

  test('changing the same field twice keeps the last choice', async ($, on) => {
    const world = setup(on)
    await start($, world)
    await $.command.run(run('sound'))
    await $.command.run(run('popup'))
    await longTurn($, world)
    expect(payloadAt(world, 0)).toMatchObject({ popup: true, sound: '' })
    expect(world.store.get('overrides')).toEqual({ delivery: { value: 'popup', base: 'popup+sound' } })
  })

  test("another session's choices are kept, and read before each ping", async ($, on) => {
    const world = setup(on)
    await start($, world)
    // Another terminal turned pings off after this session started.
    world.store.set('overrides', { enabled: { value: false, base: true } })
    await longTurn($, world)
    expect(pings(world)).toHaveLength(0)
    // Changing another field here keeps that session's choice.
    await $.command.run(run('popup'))
    expect(world.store.get('overrides')).toEqual({ enabled: { value: false, base: true }, delivery: { value: 'popup', base: 'popup+sound' } })
  })

  test('a /ping choice made over an older /config value gives way to /config', { options: { delivery: 'popup' } }, async ($, on) => {
    const world = setup(on)
    world.store.set('overrides', { delivery: { value: 'sound', base: 'popup+sound' }, events: { value: 'done', base: 'both' } })
    await start($, world)
    await longTurn($, world)
    // delivery was set over popup+sound; /config now says popup: /config wins. events still stands.
    expect(payloadAt(world, 0)).toMatchObject({ popup: true, sound: '' })
    expect(world.store.get('overrides')).toEqual({ events: { value: 'done', base: 'both' } })
  })

  test('test sends a sample now and reports it; unknown words show the help', async ($, on) => {
    const world = setup(on)
    await start($, world)
    expect((await $.command.run(run('test'))).text).toMatch(/^Sent \(popup \+ sound, via windows-toast, \d+\.\d s\)\.$/)
    await $.command.run(run('test waiting'))
    expect(payloads(world).map(p => [p.title, p.body])).toEqual([
      ['Claude Code is done', 'shop \u00b7 finished in 4m 12s'],
      ['Claude Code needs you', 'shop \u00b7 permission needed: Bash'],
    ])
    const unknown = (await $.command.run(run('bogus'))).text ?? ''
    expect(unknown).toMatch(/^Unknown command: bogus\nUsage: \/ping/)
  })

  test('test works even when pings are off', { options: { enabled: false } }, async ($, on) => {
    const world = setup(on)
    await start($, world)
    await $.command.run(run('test'))
    expect(pings(world)).toHaveLength(1)
  })
})

test('a mod installed mid-session (no session.start) still pings and registers /ping', async ($, on) => {
  const world = setup(on)
  await longTurn($, world)
  expect(pings(world)).toHaveLength(1)
  expect(world.commands).toEqual(['ping'])
})

import { describe, expect, test } from 'claude-code/testing'
import { applyOverrides, DEFAULTS, fromOptions, parseDuration } from '../hooks/config'
import {
  asnOf,
  bundleOf,
  decodePayload,
  encodePayload,
  forNotifySend,
  linuxPlayers,
  platformFromUname,
  readWindowsResult,
  unquote,
  windowsSound,
  wslEnv,
} from '../hooks/deliver'
import { duration, projectName, snippet, toolFromMessage } from '../hooks/text'
import { result } from './world'

describe('text', () => {
  test('project name from Windows, Unix and odd paths', () => {
    expect(projectName('C:\\Users\\me\\work\\shop')).toBe('shop')
    expect(projectName('C:\\Users\\me\\work\\shop\\')).toBe('shop')
    expect(projectName('/home/me/shop')).toBe('shop')
    expect(projectName('\\\\wsl.localhost\\Ubuntu\\home\\me\\api')).toBe('api')
    expect(projectName('/')).toBe('Claude Code')
    expect(projectName(undefined)).toBe('Claude Code')
  })

  test('durations in English and French', () => {
    expect(duration(45_000, 'en')).toBe('45s')
    expect(duration(252_000, 'en')).toBe('4m 12s')
    expect(duration(3_900_000, 'en')).toBe('1h 05m')
    expect(duration(45_000, 'fr')).toBe('45 s')
    expect(duration(252_000, 'fr')).toBe('4 min 12 s')
    expect(duration(3_900_000, 'fr')).toBe('1 h 05')
    expect(duration(-5, 'en')).toBe('0s')
  })

  test('a question snippet is its first line, without code or markdown, names intact', () => {
    expect(snippet('## Pick\n- **Postgres** or `sqlite`?')).toBe('Pick')
    expect(snippet('```sh\nrm -rf /\n```\nKeep **__init__.py** or test_data.json?\nline two')).toBe('Keep __init__.py or test_data.json?')
    expect(snippet('See [the docs](https://example.com/x) first')).toBe('See the docs first')
    expect(snippet('x'.repeat(150))).toHaveLength(100)
    expect(snippet('x'.repeat(150)).endsWith('\u2026')).toBe(true)
    expect(snippet(42)).toBe('')
  })

  test("the tool name from an SDK host's permission notice; the terminal's has none", () => {
    expect(toolFromMessage('Claude needs your permission to use Bash')).toBe('Bash')
    expect(toolFromMessage('Claude needs your permission to use Create Issue.')).toBe('Create Issue')
    expect(toolFromMessage('Claude needs your permission')).toBeNull()
    expect(toolFromMessage('Claude Code needs your approval for the plan')).toBeNull()
  })
})

describe('config', () => {
  test('options are checked; bad values fall back to the defaults; pasted quotes come off', () => {
    const config = fromOptions({
      events: 'nonsense',
      delivery: 'sound',
      doneAfterSeconds: -4,
      focusApps: ' WindowsTerminal ;Code,, ',
      language: 'fr',
      doneSoundFile: ' "C:\\Users\\me\\Music\\done.wav" ',
    })
    expect(config).toMatchObject({ events: 'both', delivery: 'sound', doneAfterSeconds: 60, focusApps: ['WindowsTerminal', 'Code'], language: 'fr' })
    expect(config.doneSoundFile).toBe('C:\\Users\\me\\Music\\done.wav')
    expect(fromOptions({})).toEqual(DEFAULTS)
    expect(fromOptions({ doneAfterSeconds: 999_999 }).doneAfterSeconds).toBe(86_400)
  })

  test('durations typed after /ping', () => {
    expect(parseDuration('90')).toBe(90)
    expect(parseDuration('90s')).toBe(90)
    expect(parseDuration('2m')).toBe(120)
    expect(parseDuration('2 min')).toBe(120)
    expect(parseDuration('1.5m')).toBe(90)
    expect(parseDuration('1,5 min')).toBe(90)
    expect(parseDuration('1h')).toBe(3600)
    expect(parseDuration('0')).toBe(0)
    expect(parseDuration('25h')).toBeNull()
    expect(parseDuration('soon')).toBeNull()
    expect(parseDuration('-5')).toBeNull()
  })

  test('an override stands while /config keeps the value it was made over', () => {
    const base = fromOptions({ delivery: 'popup' })
    expect(applyOverrides(base, { delivery: { value: 'sound', base: 'popup' } }).config.delivery).toBe('sound')
    const stale = applyOverrides(base, { delivery: { value: 'sound', base: 'popup+sound' } })
    expect(stale.config.delivery).toBe('popup')
    expect(stale.kept).toEqual({})
    expect(applyOverrides(base, { delivery: { value: 'loud', base: 'popup' } }).config.delivery).toBe('popup')
  })
})

describe('delivery helpers', () => {
  test('the payload is ASCII all the way down and round-trips accents, emoji and quotes', () => {
    const value = { title: 'Claude Code a terminé \u00b7 \u00e9\u00e0\u00e7 \ud83c\udf89', body: 'quotes " \' $(x) `y` <b>&amp; \n line \u2028' }
    const encoded = encodePayload(value)
    expect(/^[A-Za-z0-9+/=]+$/.test(encoded)).toBe(true)
    // The script reads the bytes as UTF-8: every byte must be ASCII, not just the base64.
    expect(/^[\x00-\x7f]*$/.test(atob(encoded))).toBe(true)
    expect(decodePayload(encoded)).toEqual(value)
  })

  test('Windows sound choice', () => {
    const req = (sound: any) => ({ ping: { kind: 'done', title: '', body: '', tag: '' }, popup: true, sound, soundFile: '', quietWhenFocused: false, quietApps: [] }) as any
    expect(windowsSound(req('reminder'), '')).toEqual({ sound: 'Reminder', fallback: false })
    expect(windowsSound(req('none'), '')).toEqual({ sound: '', fallback: false })
    expect(windowsSound(req('custom'), 'C:\\a\\b.WAV')).toEqual({ sound: 'C:\\a\\b.WAV', fallback: false })
    expect(windowsSound(req('custom'), 'C:\\a\\b.mp3')).toEqual({ sound: 'Default', fallback: true })
    expect(windowsSound(req('custom'), '')).toEqual({ sound: 'Default', fallback: true })
  })

  test("reading the Windows script's answer", () => {
    expect(readWindowsResult(result('toast-ok'))).toMatchObject({ ok: true, reason: 'ok' })
    expect(readWindowsResult(result('toast-ok sound-ok'))).toMatchObject({ ok: true, reason: 'ok' })
    expect(readWindowsResult(result('toast-ok sound-fallback'))).toMatchObject({ ok: true, reason: 'ok-sound-fallback' })
    expect(readWindowsResult(result('toast-ok sound-failed'))).toMatchObject({ ok: true, reason: 'ok-sound-failed' })
    expect(readWindowsResult(result('toast-unconfirmed'))).toMatchObject({ ok: true, reason: 'ok-unconfirmed' })
    expect(readWindowsResult(result('sound-none'))).toMatchObject({ ok: true, reason: 'ok-scheme-silent' })
    expect(readWindowsResult(result('skipped-foreground Code', 3))).toMatchObject({ ok: false, skipped: true, reason: 'focus' })
    expect(readWindowsResult(result('toast-dropped setting=DisabledForApplication', 2))).toMatchObject({ ok: false, reason: 'toast-off-app' })
    expect(readWindowsResult(result('toast-dropped setting=DisabledByGroupPolicy', 2))).toMatchObject({ reason: 'toast-off-policy' })
    expect(readWindowsResult(result('toast-dropped setting=', 2))).toMatchObject({ reason: 'toast-dropped' })
    expect(readWindowsResult(result('sound-failed', 5))).toMatchObject({ ok: false, reason: 'sound-failed' })
    expect(readWindowsResult(result('bad-payload', 4))).toMatchObject({ ok: false, reason: 'script-error', detail: 'exit 4: bad-payload' })
    expect(readWindowsResult(result('Windows PowerShell banner', 0))).toMatchObject({ ok: false, reason: 'script-error' })
  })

  test('WSLENV names DWP_PAYLOAD once, with no flag, keeping what was there', () => {
    expect(wslEnv(undefined)).toBe('DWP_PAYLOAD')
    expect(wslEnv('WT_SESSION:WT_PROFILE_ID:')).toBe('WT_SESSION:WT_PROFILE_ID:DWP_PAYLOAD')
    expect(wslEnv('PATH/l::DWP_PAYLOAD/u')).toBe('PATH/l:DWP_PAYLOAD')
  })

  test('the system from uname -sr, WSL included', () => {
    expect(platformFromUname('Darwin 23.5.0')).toBe('macos')
    expect(platformFromUname('Linux 6.8.0-45-generic\n')).toBe('linux')
    expect(platformFromUname('Linux 5.15.167.4-microsoft-standard-WSL2')).toBe('wsl')
    expect(platformFromUname('FreeBSD 14.1-RELEASE')).toBe('unknown')
  })

  test('macOS lsappinfo parsing', () => {
    expect(asnOf('"Terminal" ASN:0x0-0x1d01d: (in front)')).toBe('ASN:0x0-0x1d01d:')
    expect(bundleOf('"CFBundleIdentifier"="com.googlecode.iterm2"')).toBe('com.googlecode.iterm2')
    expect(bundleOf('bundleID="com.apple.Terminal"')).toBe('com.apple.Terminal')
    expect(asnOf('nothing')).toBeNull()
  })

  test('notify-send text and Linux players', () => {
    expect(forNotifySend('a < b && c > d', true)).toBe('a &lt; b &amp;&amp; c &gt; d')
    expect(forNotifySend('C:\\new\\reports', false)).toBe('C:\\\\new\\\\reports')
    expect(linuxPlayers('default', '').map(p => p[0])).toEqual(['canberra-gtk-play', 'paplay', 'pw-play'])
    expect(linuxPlayers('reminder', '')[0]).toEqual(['canberra-gtk-play', '-i', 'bell'])
    expect(linuxPlayers('custom', '/x/yay.oga').map(p => p[0])).toEqual(['paplay', 'pw-play', 'canberra-gtk-play'])
    expect(linuxPlayers('custom', '/x/yay.wav').map(p => p[0])).toEqual(['paplay', 'pw-play', 'canberra-gtk-play', 'aplay'])
    expect(linuxPlayers('none', '')).toEqual([])
    expect(unquote(' "/x/y z.wav" ')).toBe('/x/y z.wav')
  })
})

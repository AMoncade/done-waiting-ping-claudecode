# done-waiting-ping

A Claude Code mod that tells you when Claude needs you, so you can work in another window:

- **Done**: a long turn has finished (or stopped on an error) while you were away.
- **Waiting**: Claude is waiting on you: a permission prompt, a question, a plan to approve, an MCP server or another Claude Code dialog asking for input.

Each ping can be a **desktop notification**, a **sound**, or **both**, and you choose which events ping. It is **native on Windows** (a real Windows notification with Windows' own sounds, nothing to install) and also works on WSL, macOS and Linux.

```
┌──────────────────────────────────────┐
│ Windows PowerShell                   │
│ Claude Code is done                  │
│ shop · finished in 4m 12s            │
│ Claude Code                          │
└──────────────────────────────────────┘
```

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install done-waiting-ping --marketplace AMoncade/done-waiting-ping-claudecode
```

Answer `y` to add the marketplace, then pick a scope (user scope = every project). The install screen lets you set the options below; the mod is active right away in that session.

From a shell (the mod loads in your next session, or after `/reload-plugins`), optionally setting options:

```
claude plugin install done-waiting-ping --marketplace AMoncade/done-waiting-ping-claudecode --config delivery=popup
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `AMoncade/done-waiting-ping-claudecode`, then **Add plugin**. (The desktop app's WSL sessions load no plugins: there, use the `claude` CLI inside WSL.)

Then check it works:

```
/ping test
/ping test waiting
```

Requires Claude Code 2.1.295 or later (the one-line shell install needs 2.1.292 or later); developed and tested on Claude Code 2.1.301. Works in the terminal, the VS Code extension and the desktop app.

## Update

Third-party marketplaces do not update by themselves unless you turn auto-update on (`/plugin`, Marketplaces, `done-waiting-ping`, Enable auto-update). To update now:

```
claude plugin update done-waiting-ping@done-waiting-ping
```

## Systems

| System | Popup | Sound | Tested |
|---|---|---|---|
| Windows 10 / 11 | Windows notification (toast) through the built-in Windows PowerShell 5.1 | Windows' notification sounds, or your `.wav` | Yes, on Windows 11 |
| WSL | The same Windows notification, through Windows' `powershell.exe` | Same as Windows | Yes, Ubuntu 24.04 on Windows 11 |
| macOS | `osascript` (`display notification`) | `afplay` with a macOS system sound or your file | Unit tests only (no Mac to test on yet) |
| Linux | `notify-send` (package `libnotify-bin` / `libnotify`) | your sound theme through `canberra-gtk-play`, else `paplay` or `pw-play`; a custom `.wav` can also go through `aplay` | Unit tests only |

If the system notification cannot be shown, the mod falls back to Claude Code's own terminal notification (a terminal bell, or your terminal's notification), and `/ping test` tells you why. On macOS a notification that macOS keeps hidden cannot be detected (see Troubleshooting). Over SSH on macOS or Linux, the terminal notification is used directly, since the remote desktop is not where you are. Headless runs (`claude -p`, and apps built on the Agent SDK) never ping.

## Choose what you get

Set the options in `/config` (search for "done-waiting-ping"), on the install screen, with `--config key=value` at install, or from a shell:

```
echo '{"delivery":"sound","waitingSound":"mail"}' | claude plugin configure done-waiting-ping@done-waiting-ping --values-stdin
```

The common choices also have a `/ping` command.

| Option | Choices | Default | What it does |
|---|---|---|---|
| Notifications on (`enabled`) | on / off | on | Every ping on or off. `/ping on`, `/ping off` |
| What to ping for (`events`) | `both`, `done`, `waiting` | `both` | Finished turns, waiting on you, or both. `/ping done`, `/ping waiting`, `/ping both` |
| How to ping (`delivery`) | `popup+sound`, `popup`, `sound` | `popup+sound` | Notification with sound, silent notification, or just the sound. `/ping popup`, `/ping sound`, `/ping popup+sound` |
| Done: minimum time without you (`doneAfterSeconds`) | seconds | 60 | A finished turn pings only when at least this long has passed since you last interacted: the start of the turn, or the last question or plan you answered. 0 = every turn. `/ping 90`, `/ping 2m` |
| Sound when done (`doneSound`) | `default`, `message`, `mail`, `reminder`, `custom`, `none` | `default` | See the sound table below |
| Sound when waiting (`waitingSound`) | same | `reminder` | A different sound, so you can tell them apart |
| Custom sound file (`doneSoundFile`, `waitingSoundFile`) | a file path | empty | Used when the sound is `custom`. On Windows: a PCM `.wav` (if the file is missing or Windows cannot play it, the default sound plays instead). A leading `~/` is your home folder. Sounds are cut at 20 seconds (30 on Linux) |
| Idle reminder (`idleReminder`) | on / off | off | Also ping when Claude Code says it has been waiting for your next message for a while |
| Show details (`showDetails`) | on / off | on | Show the tool of a permission prompt and the first line of Claude's question, as Claude wrote it (it can include file names or values; code is left out). Off: only the project and what happened |
| Quiet while you are looking (`quietWhenFocused`) | on / off | off | Skip pings while one of the listed apps has the keyboard focus. Windows and macOS only |
| Apps that count as looking (`focusApps`) | comma-separated list | `WindowsTerminal, Code, Cursor` | Windows: process names. macOS: bundle ids (the terminal Claude Code runs in always counts) |
| Language (`language`) | `en`, `fr` | `en` | Language of the notifications and of `/ping` |

### Sounds

| Choice | Windows | macOS | Linux (sound theme) |
|---|---|---|---|
| `default` | Notification.Default | Glass | complete |
| `message` | Notification.IM | Ping | message-new-instant |
| `mail` | Notification.Mail | Pop | message |
| `reminder` | Notification.Reminder | Hero | bell |
| `custom` | your `.wav` | your file | your file |
| `none` | silent | silent | silent |

On Windows the four named sounds follow your sound scheme (Control Panel > Sound > Sounds), so they sound like your other notifications; a sound set to (None) there stays silent.

### The /ping command

| Command | Does |
|---|---|
| `/ping` or `/ping status` | Shows the current settings, the system, and the last ping's result |
| `/ping on`, `/ping off` | Turns every ping on or off |
| `/ping done`, `/ping waiting`, `/ping both` | Chooses the events |
| `/ping popup`, `/ping sound`, `/ping popup+sound` | Chooses how to ping |
| `/ping 90`, `/ping 2m`, `/ping 1h` | Minimum time without you for the done ping |
| `/ping test`, `/ping test waiting` | Sends a sample now and says how it went (ignores "off" and "quiet while looking") |
| `/ping reset` | Forgets the choices made with `/ping`, back to `/config` |
| `/ping help` | Lists the commands |

`/ping` works even while Claude is busy. A choice made with `/ping` applies to every open session and is kept across sessions. If you later change the same option in `/config`, `/config` wins.

## When it pings

**Waiting.** Claude Code raises its own "needs your input" notice when a dialog has stayed open about 6 seconds without a keypress: a permission prompt, a question (AskUserQuestion), a plan to approve, an MCP server's request, a background agent that needs you. The mod pings on that notice. So nothing pings while you are answering, nothing pings for a dialog you answer within a few seconds, and in auto mode the calls the classifier approves never ping (no dialog opens). Each dialog pings once.

**Done.** When a turn of the main conversation ends on its own and at least the minimum time has passed since you last interacted: the start of the turn, or the last question or plan you answered. Claude Code does not tell plugins when you answer a permission prompt, so time spent waiting on one counts as time away: approving a prompt you left for ten minutes can be followed by a done ping soon after. Turns you interrupt (Esc) and subagents' turns never ping. A turn that ended on an error or a refusal says "Claude Code stopped". The time shown is the whole turn's.

**Idle** (off by default). When Claude Code says it has been waiting for your next message.

## What it runs, reads, sends and stores

- It sends **nothing over the network**, and reads no file of yours (except your custom sound file, to play it).
- A notification shows the project folder's name and what happened, a duration, a tool name, and (with "Show details") the first line of Claude's question as Claude wrote it, code blocks and inline code left out (it can still mention a file, a value or a command written in plain text). Never Claude's reply, a tool's input, or the text of Claude Code's own notices.
- It hooks these Claude Code events: session start, turn start and end, AskUserQuestion and ExitPlanMode tool calls (to know when a question or plan dialog is open, and when you answered it), permission requests (for the tool's name; it never changes the decision), notifications, and its `/ping` command.
- It reads these environment variables to know where it runs: `CLAUDE_CODE_ENTRYPOINT` (to tell a headless run), `OS`, `SystemRoot`, `WSL_DISTRO_NAME`, `WSLENV`, `HOME`, `__CFBundleIdentifier` (macOS), `SSH_CONNECTION` and `SSH_TTY`.
- It runs these programs, each as an argument list with no shell, the text never placed inside a script:
  - **Windows**: `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <plugin>\scripts\notify-windows.ps1`, with the notification's text in the `DWP_PAYLOAD` environment variable (base64 of JSON). `-ExecutionPolicy Bypass` applies to that one process only. The script, [scripts/notify-windows.ps1](scripts/notify-windows.ps1), is short; it:
    - shows the toast through the Windows notification API under the Windows PowerShell app id, then reads that app's notification history to check the toast was kept;
    - with a popup and a named sound, lets the toast play the sound itself;
    - otherwise plays the sound with `System.Media.SoundPlayer`: your `.wav` (quotes, `%VARIABLES%` and a leading `~` resolved), or the `.wav` your sound scheme maps the event to (it reads `HKCU\AppEvents\Schemes\Apps\.Default\Notification.<event>`), falling back to `%WINDIR%\Media\Windows Notify System Generic.wav`, for at most 20 seconds;
    - only when "Quiet while you are looking" is on: asks `user32.dll` (`GetForegroundWindow`, `GetWindowThreadProcessId`) which process has the keyboard focus, through a P/Invoke declared at run time, and reads that process's name;
    - parses the request with the JSON parser that ships with .NET Framework (`System.Web.Extensions`).
  - **WSL**: `uname -sr`, `wslpath` (to find `powershell.exe` and the script's Windows path, and your custom sound's), then the same `powershell.exe` with `DWP_PAYLOAD` added to `WSLENV` for it.
  - **macOS**: `uname -sr`, `osascript`, `afplay`, and `lsappinfo` when "Quiet while you are looking" is on.
  - **Linux**: `uname -sr`, `notify-send`, then `canberra-gtk-play`, `paplay`, `pw-play` or `aplay`.
- It stores only the choices you make with `/ping`, in the plugin's own storage in your Claude Code config folder.

## Troubleshooting

- **Nothing shows on Windows.** Run `/ping test`; it says why. Notifications can be off for Windows PowerShell or for all apps (Settings > System > Notifications), or blocked by your organization. The toast carries the Windows PowerShell name and icon, as it is shown through it. Do Not Disturb hides banners and mutes the sound a toast plays itself; they still land in the notification center. A sound the mod plays itself ("sound only", or your custom `.wav`) plays even during Do Not Disturb.
- **Nothing shows on macOS.** macOS credits `osascript` notifications to Script Editor: allow notifications for Script Editor in System Settings > Notifications. The sound plays through `afplay` either way.
- **No sound.** Check the volume, and that the chosen sound is not `none`. With "sound only" and a sound set to `none`, nothing is sent. On Linux, install a sound theme (`sound-theme-freedesktop`) and `canberra-gtk-play` or `paplay`.
- **On a work computer** where PowerShell runs in Constrained Language mode, the Windows notification cannot be shown; the mod falls back to the terminal notification.
- **Organizations that manage Claude Code**: Claude Code does not pass its notices and permission requests to plugins a person installed themselves there, so only done pings work.
- **Details**: run Claude Code with `claude --debug`; each ping writes a `done-waiting-ping:` line with where it went, why, and how long it took.

## Uninstall

```
/plugin uninstall done-waiting-ping
```

## Develop

```
claude plugin validate .
claude plugin test .
```

`hooks/register.ts` wires the events and the `/ping` command, `hooks/config.ts` reads the options, `hooks/text.ts` holds every word (English and French), `hooks/deliver.ts` runs the system's notifier, and `scripts/notify-windows.ps1` is the Windows side. Tests are in `tests/`.

## Credits

Inspired by [partalemre/MODZ](https://github.com/partalemre/MODZ) `done-ping` and [jrlprost/claude-code-mods](https://github.com/jrlprost/claude-code-mods) `jr-done-ping`. The macOS notifier follows MODZ's approach (see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).

## License

MIT, see [LICENSE](LICENSE).

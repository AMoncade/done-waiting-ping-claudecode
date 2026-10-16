# done-waiting-ping: shows one Windows notification and/or plays one sound.
#
# Run by the mod as:
#   powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File notify-windows.ps1
# with the request in the environment variable DWP_PAYLOAD: base64 of an ASCII-only JSON object
#   { title, body, attribution?, popup, sound, tag?, group?, expireMinutes?, quietWhenForeground? }
# where sound is '' (silent), a Windows notification sound event name (Default, IM, Mail, Reminder)
# or the path of a .wav file.
#
# It uses only what ships with Windows 10/11 (Windows PowerShell 5.1) and does exactly this:
#   - shows the toast through the WinRT notification API under the Windows PowerShell app id,
#     then reads that app's notification history to confirm the toast landed;
#   - with a popup and a named sound, the toast itself plays the sound (ms-winsoundevent);
#   - otherwise plays a sound with System.Media.SoundPlayer: your .wav (quotes, %VARIABLES% and a
#     leading ~ resolved), or the .wav your sound scheme maps the event to (read from
#     HKCU\AppEvents\Schemes\Apps\.Default\Notification.<event>), falling back to
#     %WINDIR%\Media\Windows Notify System Generic.wav; at most 20 seconds;
#   - only when quietWhenForeground lists apps: asks user32 (GetForegroundWindow,
#     GetWindowThreadProcessId, through a P/Invoke declared at run time) which process has the
#     keyboard focus, reads that process's name, and stays quiet if it is listed.
# The request is parsed with the JSON parser of System.Web.Extensions (part of .NET Framework).
# It writes nothing and sends nothing over the network.
#
# stdout is one ASCII status line of space-separated words; the first says what happened:
#   toast-ok | toast-unconfirmed | sound-ok | sound-fallback | sound-none      exit 0
#     (after the toast: sound-ok, sound-fallback = your .wav was unusable and the default sound
#      played instead, sound-failed, sound-none = the scheme maps the event to no sound)
#   error <type> <hresult>       exit 1   unexpected error
#   toast-dropped setting=<s>    exit 2   Windows did not keep the toast (notifications off)
#   skipped-foreground <name>    exit 3   a listed app has the focus
#   bad-payload                  exit 4   the request is missing or malformed
#   sound-failed                 exit 5   sound only, and no sound could be played

$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
function Out1([string]$s) { [Console]::Out.Write($s) }

try {
  $raw = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$env:DWP_PAYLOAD))
  $null = [Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
  $P = [System.Web.Script.Serialization.JavaScriptSerializer]::new().DeserializeObject($raw)
} catch { Out1 'bad-payload'; exit 4 }
# A missing variable decodes to nothing at all: say so rather than succeed silently.
if (-not ($P -is [System.Collections.IDictionary])) { Out1 'bad-payload'; exit 4 }

# Text for the toast XML: newlines normalised, control characters, U+FFFE/U+FFFF and lone
# surrogates removed, clipped without splitting a surrogate pair, then XML-escaped.
function Clean([object]$v, [int]$max) {
  if ($null -eq $v) { return '' }
  $s = [regex]::Replace([string]$v, '\r\n?', [string][char]10)
  $s = [regex]::Replace($s, '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]', '')
  # .NET's regex does not match U+FFFF in a character class: plain replaces for the two non-characters.
  $s = $s.Replace([string][char]0xFFFE, '').Replace([string][char]0xFFFF, '')
  if ($s.Length -gt $max) {
    $cut = $max - 1
    if ([char]::IsHighSurrogate($s[$cut - 1])) { $cut-- }
    $s = $s.Substring(0, $cut) + [char]0x2026
  }
  return [System.Security.SecurityElement]::Escape($s)
}

# Length of a .wav in milliseconds: the 'data' chunk's size over the 'fmt ' chunk's byte rate,
# walking the RIFF chunks (a JUNK, LIST or bext chunk may come first). Unknown: 20 s or more.
function WavMs([string]$path) {
  try {
    $fs = [IO.File]::OpenRead($path)
    try {
      $br = [IO.BinaryReader]::new($fs)
      $null = $br.ReadBytes(12)
      $byteRate = 0; $dataSize = -1
      while ($fs.Position + 8 -le $fs.Length -and ($byteRate -eq 0 -or $dataSize -lt 0)) {
        $id = [Text.Encoding]::ASCII.GetString($br.ReadBytes(4))
        $size = [long]$br.ReadUInt32()
        $next = $fs.Position + $size + ($size % 2)
        if ($id -eq 'fmt ' -and $size -ge 12) { $null = $br.ReadBytes(8); $byteRate = $br.ReadInt32() }
        elseif ($id -eq 'data') { $dataSize = $size }
        $fs.Position = $next
      }
      if ($byteRate -gt 0 -and $dataSize -ge 0) { return [long]($dataSize * 1000 / $byteRate) }
    } finally { $fs.Dispose() }
  } catch {}
  return [long]20001
}

# Plays a .wav to its end, at most 20 s; false when SoundPlayer cannot play it (for example a
# WAVE_FORMAT_EXTENSIBLE file, which .NET Framework refuses).
function PlayWav([string]$path) {
  try {
    $player = [System.Media.SoundPlayer]::new($path)
    $player.Load()
    $ms = WavMs $path
    if ($ms -le 20000) { $player.PlaySync() } else { $player.Play(); [Threading.Thread]::Sleep(20000); $player.Stop() }
    return $true
  } catch { return $false }
}

try {
  # Optional: stay quiet while one of the listed apps (process names) has the keyboard focus.
  $quiet = @($P.quietWhenForeground)
  if ($quiet.Count -gt 0 -and $null -ne $quiet[0]) {
    $ab = [AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('DwpFg'), 'Run')
    $tb = $ab.DefineDynamicModule('DwpFg').DefineType('DwpFg.U', 'Public, Class')
    $m = $tb.DefinePInvokeMethod('GetForegroundWindow', 'user32.dll', 'Public, Static, PinvokeImpl', 'Standard', [IntPtr], [Type[]]@(), 'Winapi', 'Auto'); $m.SetImplementationFlags('PreserveSig')
    $m = $tb.DefinePInvokeMethod('GetWindowThreadProcessId', 'user32.dll', 'Public, Static, PinvokeImpl', 'Standard', [UInt32], [Type[]]@([IntPtr], [UInt32].MakeByRefType()), 'Winapi', 'Auto'); $m.SetImplementationFlags('PreserveSig')
    $U = $tb.CreateType()
    $fgPid = [UInt32]0; [void]$U::GetWindowThreadProcessId($U::GetForegroundWindow(), [ref]$fgPid)
    $fg = ''; try { $fg = [Diagnostics.Process]::GetProcessById([int]$fgPid).ProcessName } catch {}
    if ($quiet -contains $fg) { Out1 ('skipped-foreground ' + $fg); exit 3 }
  }

  $generic = [Environment]::GetFolderPath('Windows') + '\Media\Windows Notify System Generic.wav'
  $events = @('Default', 'IM', 'Mail', 'Reminder')
  $sound = [string]$P.sound
  $isEvent = $events -contains $sound
  $wav = $null
  $fallback = $false
  if ($sound -and -not $isEvent) {
    # A custom file: quotes from "Copy as path", %VARIABLES% and a leading ~ are accepted.
    $path = [Environment]::ExpandEnvironmentVariables($sound.Trim().Trim('"').Trim("'"))
    if ($path.StartsWith('~\') -or $path.StartsWith('~/')) { $path = [Environment]::GetFolderPath('UserProfile') + $path.Substring(1) }
    if ($path.EndsWith('.wav', 'OrdinalIgnoreCase') -and [IO.File]::Exists($path)) { $wav = $path }
    else { $sound = 'Default'; $isEvent = $true; $fallback = $true }
  }
  $status = ''

  if ($P.popup) {
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
    $aumid = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    # The toast carries its own sound only for an event name; a .wav plays after a silent toast.
    $audio = '<audio silent="true"/>'
    if ($isEvent -and -not $wav) { $audio = '<audio src="ms-winsoundevent:Notification.' + $sound + '"/>' }
    $attr = ''
    if ($P.attribution) { $attr = '<text placement="attribution">' + (Clean $P.attribution 60) + '</text>' }
    $xml = '<toast><visual><binding template="ToastGeneric"><text>' + (Clean $P.title 120) + '</text><text>' + (Clean $P.body 400) + '</text>' + $attr + '</binding></visual>' + $audio + '</toast>'
    $doc = [Windows.Data.Xml.Dom.XmlDocument]::new()
    $doc.LoadXml($xml)
    $toast = [Windows.UI.Notifications.ToastNotification]::new($doc)
    $tag = [string]$P.tag; if (-not $tag) { $tag = 'dwp' }; if ($tag.Length -gt 60) { $tag = $tag.Substring(0, 60) }
    $group = [string]$P.group; if (-not $group) { $group = 'done-waiting-ping' }; if ($group.Length -gt 60) { $group = $group.Substring(0, 60) }
    $toast.Tag = $tag; $toast.Group = $group
    if ($P.expireMinutes -gt 0) { $toast.ExpirationTime = [DateTimeOffset]::Now.AddMinutes([double]$P.expireMinutes) }
    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid)
    $notifier.Show($toast)
    # Windows drops a toast silently when notifications are off: check it landed. The setting
    # can only be read once the app id has shown a toast, so it is read after Show().
    $setting = ''
    try { $setting = [string]$notifier.Setting } catch {}
    $found = $false
    foreach ($h in [Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory($aumid)) { if ($h.Tag -eq $tag -and $h.Group -eq $group) { $found = $true; break } }
    if ($found) { $status = 'toast-ok' }
    elseif ($setting -eq 'Enabled') { $status = 'toast-unconfirmed' }  # banner on, notification center off
    else { Out1 ('toast-dropped setting=' + $setting); exit 2 }
    if ($fallback) { $status += ' sound-fallback' }
  }

  # Sound on its own: the .wav, or the file the user's sound scheme maps the event to.
  if ($wav -or ($isEvent -and -not $P.popup)) {
    $schemeNone = $false
    if (-not $wav) {
      $v = [Microsoft.Win32.Registry]::GetValue('HKEY_CURRENT_USER\AppEvents\Schemes\Apps\.Default\Notification.' + $sound + '\.Current', '', $null)
      if ($null -ne $v -and [string]$v -eq '') { $schemeNone = $true }
      elseif ($v -and [IO.File]::Exists([Environment]::ExpandEnvironmentVariables([string]$v))) { $wav = [Environment]::ExpandEnvironmentVariables([string]$v) }
      else { $wav = $generic }
    }
    if ($schemeNone) {
      $status += ' sound-none'
    } elseif (PlayWav $wav) {
      if ($fallback) { $status += ' sound-fallback' } else { $status += ' sound-ok' }
    } elseif ($wav -ne $generic -and (PlayWav $generic)) {
      $status += ' sound-fallback'
    } else {
      if (-not $P.popup) { Out1 'sound-failed'; exit 5 }
      $status += ' sound-failed'
    }
  }
  Out1 $status.Trim()
  exit 0
} catch {
  Out1 ('error ' + $_.Exception.GetType().Name + ' 0x' + $_.Exception.HResult.ToString('X8'))
  exit 1
}

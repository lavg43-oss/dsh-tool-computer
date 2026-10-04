# dsh-tool-computer - Windows desktop control runner.
# Reads one JSON object on stdin, writes one JSON object on stdout.
# Actions: screenshot | click | double_click | right_click | move | drag | scroll |
#          type | key | keys | cursor | windows | focus_window | wait
# Exit codes: 0 ok, 2 no interactive desktop, 3 usage/validation error, 1 unexpected failure.
[CmdletBinding()]
param(
  # Server mode: serves requests from stdin until the stream closes.
  # Without it, processes a single request and exits (backwards compatible).
  [switch]$Server
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = [System.Text.Encoding]::UTF8

class Fail : System.Exception {
  [int]$Code
  [string]$Action
  Fail([string]$message, [int]$code, [string]$action) : base($message) {
    $this.Code = $code
    $this.Action = $action
  }
}

# Clock and helpers at script scope: the main loop uses them too.
$script:SW = [System.Diagnostics.Stopwatch]::StartNew()
function Elapsed { return [int]$script:SW.ElapsedMilliseconds }
function Wait-Ms([int]$ms) { if ($ms -gt 0) { Start-Sleep -Milliseconds $ms } }
function Throw-Fail([string]$message, [int]$code = 3, [string]$action = '') {
  throw [Fail]::new($message, $code, $action)
}

# All the initialization work lives here so the same code serves both modes: one
# request (fresh process) or many (persistent server, which does not pay for the
# PowerShell startup or the native compilation again).
function Initialize-Native {
# ── native surface ────────────────────────────────────────────────────────────
Add-Type -AssemblyName System.Drawing
$script:HasForms = $true
try { Add-Type -AssemblyName System.Windows.Forms } catch { $script:HasForms = $false }

$native = @'
using System;
using System.Runtime.InteropServices;

public static class DshNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion u; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, IntPtr extra);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hwnd, System.Text.StringBuilder buffer, int maxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT value, int size);

  public const int MOUSEEVENTF_MOVE = 0x0001;
  public const int MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const int MOUSEEVENTF_LEFTUP = 0x0004;
  public const int MOUSEEVENTF_RIGHTDOWN = 0x0008;
  public const int MOUSEEVENTF_RIGHTUP = 0x0010;
  public const int MOUSEEVENTF_WHEEL = 0x0800;
  public const int MOUSEEVENTF_HWHEEL = 0x1000;
  public const uint INPUT_MOUSE = 0;
  public const uint INPUT_KEYBOARD = 1;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
  public const uint KEYEVENTF_UNICODE = 0x0004;

  static INPUT Mouse(int flags, int data) {
    INPUT input = new INPUT();
    input.type = INPUT_MOUSE;
    input.u.mi.dwFlags = (uint)flags;
    input.u.mi.mouseData = (uint)data;
    return input;
  }
  public static void MouseClick(int flagsDown, int flagsUp) {
    INPUT[] batch = new INPUT[2];
    batch[0] = Mouse(flagsDown, 0);
    batch[1] = Mouse(flagsUp, 0);
    SendInput(2, batch, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void MouseWheel(int delta, bool horizontal) {
    INPUT[] batch = new INPUT[1];
    batch[0] = Mouse(horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL, delta);
    SendInput(1, batch, Marshal.SizeOf(typeof(INPUT)));
  }
  public static uint Key(ushort vk, ushort scan, bool up, bool extended) {
    INPUT input = new INPUT();
    input.type = INPUT_KEYBOARD;
    input.u.ki.wVk = vk;
    input.u.ki.wScan = scan;
    input.u.ki.dwFlags = (up ? KEYEVENTF_KEYUP : 0) | (extended ? KEYEVENTF_EXTENDEDKEY : 0) | (vk == 0 ? KEYEVENTF_UNICODE : 0);
    INPUT[] batch = new INPUT[1] { input };
    return SendInput(1, batch, Marshal.SizeOf(typeof(INPUT)));
  }
  public static int VirtualScreenLeft() { return GetSystemMetrics(76); }
  public static int VirtualScreenTop() { return GetSystemMetrics(77); }
  public static int VirtualScreenWidth() { return GetSystemMetrics(78); }
  public static int VirtualScreenHeight() { return GetSystemMetrics(79); }

  public static bool HasInteractiveDesktop() {
    IntPtr desktop = OpenInputDesktop(0, false, 0x0001);
    if (desktop == IntPtr.Zero) return false;
    CloseDesktop(desktop);
    return true;
  }
  public static bool WindowBounds(IntPtr hwnd, out RECT rect) {
    rect = new RECT();
    rect.Left = 0; rect.Top = 0; rect.Right = 0; rect.Bottom = 0;
    RECT frame = new RECT();
    if (DwmGetWindowAttribute(hwnd, 9, out frame, Marshal.SizeOf(typeof(RECT))) == 0) { rect = frame; return true; }
    return GetWindowRect(hwnd, out rect);
  }
  public static string ProcessNameOf(uint pid) {
    try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; }
    catch { return ""; }
  }
  public static IntPtr RootWindowAt(int x, int y) {
    POINT point;
    point.X = x; point.Y = y;
    IntPtr hwnd = WindowFromPoint(point);
    if (hwnd == IntPtr.Zero) return IntPtr.Zero;
    return GetAncestor(hwnd, 2);
  }
  public static uint WindowPid(IntPtr hwnd) {
    uint pid;
    GetWindowThreadProcessId(hwnd, out pid);
    return pid;
  }

  /* EnumWindows works where Get-Process's MainWindowHandle does not (the sandbox
     leaves the latter at zero), so window discovery goes through user32. */
  public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

  public static uint[] TopLevelWindowHandles() {
    System.Collections.Generic.List<uint> handles = new System.Collections.Generic.List<uint>();
    EnumWindows(delegate(IntPtr hwnd, IntPtr param) {
      handles.Add((uint)hwnd.ToInt64());
      return true;
    }, IntPtr.Zero);
    return handles.ToArray();
  }
  public static string WindowTitle(IntPtr hwnd) {
    System.Text.StringBuilder buffer = new System.Text.StringBuilder(512);
    int length = GetWindowTextW(hwnd, buffer, buffer.Capacity);
    return length > 0 ? buffer.ToString() : "";
  }
  public static bool WindowIsTopmost(IntPtr hwnd) {
    return GetWindow(hwnd, 3) == IntPtr.Zero; /* GW_OWNER */
  }
  public static void WindowClose(IntPtr hwnd) {
    PostMessageW(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero); /* WM_CLOSE */
  }
}
'@

try {
  [void][DshNative]
} catch {
  try {
    Add-Type -TypeDefinition $native -Language CSharp
  } catch {
    Throw-Fail "could not compile the native surface (Add-Type): $($_.Exception.Message)" 1
  }
}

# Per-monitor-v2 (value -4, as a sign-extended pointer) beats plain SetProcessDPIAware.
try { [void][DshNative]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { }
try { [void][DshNative]::SetProcessDPIAware() } catch { }

if (-not [DshNative]::HasInteractiveDesktop()) {
  Throw-Fail 'no interactive desktop is reachable from this process (non-interactive window station); I cannot capture or inject input' 2
}
}
# ── end of Initialize-Native ──────────────────────────────────────────────────

# ── helpers ───────────────────────────────────────────────────────────────────
$script:TempRoot = Join-Path $env:TEMP 'dsh-computer'
if (-not (Test-Path $script:TempRoot)) { New-Item -ItemType Directory -Path $script:TempRoot -Force | Out-Null }

$VK = @{
  'BACKSPACE' = 0x08; 'TAB' = 0x09; 'CLEAR' = 0x0C; 'ENTER' = 0x0D; 'RETURN' = 0x0D; 'SHIFT' = 0x10
  'CTRL' = 0x11; 'CONTROL' = 0x11; 'ALT' = 0x12; 'PAUSE' = 0x13; 'CAPSLOCK' = 0x14; 'ESC' = 0x1B; 'ESCAPE' = 0x1B
  'SPACE' = 0x20; 'PAGEUP' = 0x21; 'PRIOR' = 0x21; 'PAGEDOWN' = 0x22; 'NEXT' = 0x22; 'END' = 0x23; 'HOME' = 0x24
  'LEFT' = 0x25; 'UP' = 0x26; 'RIGHT' = 0x27; 'DOWN' = 0x28; 'PRINTSCREEN' = 0x2C; 'SNAPSHOT' = 0x2C
  'INSERT' = 0x2D; 'DELETE' = 0x2E; 'DEL' = 0x2E; 'WIN' = 0x5B; 'WINDOWS' = 0x5B; 'LWIN' = 0x5B; 'RWIN' = 0x5C
  'APPS' = 0x5D; 'NUMLOCK' = 0x90; 'SCROLLLOCK' = 0x91; 'LSHIFT' = 0xA0; 'RSHIFT' = 0xA1
  'LCTRL' = 0xA2; 'RCTRL' = 0xA3; 'LALT' = 0xA4; 'RALT' = 0xA5
  'SEMICOLON' = 0xBA; 'PLUS' = 0xBB; 'COMMA' = 0xBC; 'MINUS' = 0xBD; 'PERIOD' = 0xBE; 'SLASH' = 0xBF
  'TILDE' = 0xC0; 'LBRACKET' = 0xDB; 'BACKSLASH' = 0xDC; 'RBRACKET' = 0xDD; 'QUOTE' = 0xDE
  'VOLUMEUP' = 0xAF; 'VOLUMEDOWN' = 0xAE; 'VOLUMEMUTE' = 0xAD
}
for ($i = 0; $i -lt 24; $i++) { $VK["F$($i + 1)"] = 0x70 + $i }
for ($i = 0; $i -lt 10; $i++) { $VK["NUMPAD$i"] = 0x60 + $i }

# Applications that the start_app action may open. An allowlist, not a free path:
# launching arbitrary processes would be a much larger capability than requested.
$script:Apps = @{
  'notepad' = 'notepad.exe'; 'bloc' = 'notepad.exe'; 'calculator' = 'calc.exe'; 'calc' = 'calc.exe'
  'paint' = 'mspaint.exe'; 'explorer' = 'explorer.exe'; 'cmd' = 'cmd.exe'; 'powershell' = 'powershell.exe'
}
function Get-AppExecutable([string]$app) {
  $name = $app.Trim().ToLowerInvariant()
  if ($name -eq '') { throw 'start_app needs app' }
  if (-not $script:Apps.ContainsKey($name)) {
    throw "app not allowed: '$app'. Allowed: $(($script:Apps.Keys | Sort-Object) -join ', ')"
  }
  return $script:Apps[$name]
}
function Do-StartApp([string]$app) {
  $executable = Get-AppExecutable $app
  $process = Start-Process -FilePath $executable -PassThru
  $handle = 0
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Wait-Ms 250
    foreach ($candidate in [DshNative]::TopLevelWindowHandles()) {
      $hwnd = [IntPtr]$candidate
      if (-not [DshNative]::IsWindowVisible($hwnd)) { continue }
      if ([DshNative]::WindowPid($hwnd) -ne $process.Id) { continue }
      $handle = [int64]$candidate
      break
    }
    if ($handle -ne 0) { break }
  }
  $info = $null
  if ($handle -ne 0) { $info = Get-WindowInfo $handle }
  return [ordered]@{
    ok = $true; action = 'start_app'; app = $app; executable = $executable
    pid = $process.Id; handle = $handle
    title = if ($info) { $info.title } else { '' }
    bounds = if ($info) { $info.bounds } else { $null }
    foreground = if ($info) { $info.foreground } else { $false }
    ms = (Elapsed)
  }
}
$script:ExtendedKeys = @('UP', 'DOWN', 'LEFT', 'RIGHT', 'HOME', 'END', 'PAGEUP', 'PAGEDOWN', 'PRIOR', 'NEXT',
  'INSERT', 'DELETE', 'DEL', 'WIN', 'WINDOWS', 'LWIN', 'RWIN', 'APPS', 'PRINTSCREEN', 'SNAPSHOT', 'NUMLOCK')

function Resolve-Vk([string]$key) {
  if ([string]::IsNullOrWhiteSpace($key)) { throw 'empty key name' }
  $name = $key.Trim().ToUpperInvariant()
  if ($name.Length -eq 1) {
    $c = [char]$name[0]
    if ([char]::IsLetter($c) -or [char]::IsDigit($c)) { return [int][char]$c }
  }
  $alias = @{ 'CMD' = 'WIN'; 'META' = 'WIN'; 'OPTION' = 'ALT'; 'COMMAND' = 'WIN'; 'ESCAPE' = 'ESC'; 'RETURN' = 'ENTER' }
  if ($alias.ContainsKey($name)) { $name = $alias[$name] }
  if ($VK.ContainsKey($name)) { return [int]$VK[$name] }
  throw "unknown key: '$key'"
}
function Key-Press([string]$key, [int]$holdMs = 12) {
  $vk = Resolve-Vk $key
  $name = $key.Trim().ToUpperInvariant()
  $extended = $script:ExtendedKeys -contains $name
  [void][DshNative]::Key([uint16]$vk, 0, $false, $extended)
  if ($holdMs -gt 0) { Wait-Ms $holdMs }
  [void][DshNative]::Key([uint16]$vk, 0, $true, $extended)
}
function Screen-Bounds {
  $left = [DshNative]::VirtualScreenLeft(); $top = [DshNative]::VirtualScreenTop()
  $width = [DshNative]::VirtualScreenWidth(); $height = [DshNative]::VirtualScreenHeight()
  if ($width -le 0 -or $height -le 0) { throw 'the virtual desktop does not report a size' }
  return [pscustomobject]@{ left = $left; top = $top; width = $width; height = $height }
}
function Monitor-Indices { [int[]]@(0) }
function Save-Frame([System.Drawing.Bitmap]$bitmap, [int]$index) {
  $path = Join-Path $script:TempRoot "screen-$index.png"
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  return $path
}
function Prune-Frames([int]$keep) {
  $names = @(Get-ChildItem -Path $script:TempRoot -Filter '*.png' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
  if ($names.Count -gt $keep) { $names | Select-Object -Last ($names.Count - $keep) | Remove-Item -Force -ErrorAction SilentlyContinue }
}

$script:LastFrame = 0
function Do-Screenshot([int]$maxWidth, [int]$maxHeight) {
  $area = Screen-Bounds
  $bitmap = New-Object System.Drawing.Bitmap $area.width, $area.height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.CopyFromScreen($area.left, $area.top, 0, 0, (New-Object System.Drawing.Size $area.width, $area.height))
    } finally { $graphics.Dispose() }
    $scale = 1.0
    if ($bitmap.Width -gt $maxWidth -or $bitmap.Height -gt $maxHeight) {
      $scale = [Math]::Min($maxWidth / $bitmap.Width, $maxHeight / $bitmap.Height)
      $nw = [int][Math]::Max(1, [Math]::Round($bitmap.Width * $scale))
      $nh = [int][Math]::Max(1, [Math]::Round($bitmap.Height * $scale))
      $small = New-Object System.Drawing.Bitmap $nw, $nh, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
      $g2 = [System.Drawing.Graphics]::FromImage($small)
      try {
        $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g2.DrawImage($bitmap, 0, 0, $nw, $nh)
      } finally { $g2.Dispose() }
      $bitmap.Dispose()
      $bitmap = $small
    }
    $script:LastFrame++
    $path = Save-Frame $bitmap $script:LastFrame
    $imageWidth = $bitmap.Width; $imageHeight = $bitmap.Height
    return [ordered]@{
      ok = $true
      action = 'screenshot'
      path = $path
      mediaType = 'image/png'
      image = [ordered]@{ width = $imageWidth; height = $imageHeight }
      screen = [ordered]@{ left = $area.left; top = $area.top; width = $area.width; height = $area.height }
      scale = [Math]::Round(($area.width / $imageWidth), 6)
      frame = $script:LastFrame
      ms = (Elapsed)
    }
  } finally { $bitmap.Dispose() }
}

function Do-Cursor {
  $point = New-Object 'DshNative+POINT'
  [void][DshNative]::GetCursorPos([ref]$point)
  $hwnd = [DshNative]::GetForegroundWindow()
  $title = New-Object System.Text.StringBuilder 512
  [void][DshNative]::GetWindowTextW($hwnd, $title, 512)
  return [ordered]@{
    ok = $true; action = 'cursor'
    x = $point.X; y = $point.Y
    foreground = $title.ToString()
    ms = (Elapsed)
  }
}

function Get-WindowInfo([int64]$handle) {
  $hwnd = [IntPtr]$handle
  $title = [DshNative]::WindowTitle($hwnd)
  $rect = New-Object 'DshNative+RECT'
  [void][DshNative]::WindowBounds($hwnd, [ref]$rect)
  $winPid = [int][DshNative]::WindowPid($hwnd)
  return [ordered]@{
    handle = $handle
    title = $title
    pid = $winPid
    process = [DshNative]::ProcessNameOf([uint32]$winPid)
    visible = [bool][DshNative]::IsWindowVisible($hwnd)
    minimized = [bool][DshNative]::IsIconic($hwnd)
    bounds = [ordered]@{ left = $rect.Left; top = $rect.Top; width = ($rect.Right - $rect.Left); height = ($rect.Bottom - $rect.Top) }
  }
}

function Do-Windows {
  $current = [DshNative]::GetForegroundWindow()
  $list = New-Object System.Collections.ArrayList
  foreach ($handle in [DshNative]::TopLevelWindowHandles()) {
    $hwnd = [IntPtr]$handle
    if (-not [DshNative]::IsWindow($hwnd)) { continue }
    $visible = [DshNative]::IsWindowVisible($hwnd)
    $title = [DshNative]::WindowTitle($hwnd)
    if (-not $visible -and $title -eq '') { continue }
    $rect = New-Object 'DshNative+RECT'
    [void][DshNative]::WindowBounds($hwnd, [ref]$rect)
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -lt 40 -or $height -lt 40) { continue }
    $owner = ($title -eq '' -and [DshNative]::WindowIsTopmost($hwnd) -and -not $visible)
    if ($owner) { continue }
    $winPid = [int][DshNative]::WindowPid($hwnd)
    [void]$list.Add([pscustomobject][ordered]@{
        handle = [int64]$handle
        title = $title
        pid = $winPid
        process = [DshNative]::ProcessNameOf([uint32]$winPid)
        visible = [bool]$visible
        minimized = [bool][DshNative]::IsIconic($hwnd)
        bounds = [ordered]@{ left = $rect.Left; top = $rect.Top; width = $width; height = $height }
        foreground = ($hwnd -eq $current)
      })
  }
  $sorted = @($list | Sort-Object -Property @{ Expression = 'foreground'; Descending = $true }, @{ Expression = 'visible'; Descending = $true }, 'title')
  return [ordered]@{ ok = $true; action = 'windows'; count = $sorted.Count; windows = $sorted; ms = (Elapsed) }
}

function Get-WindowByQuery([string]$query, [int64]$handle, [switch]$visibleOnly) {
  if ($handle -ne 0) {
    $hwnd = [IntPtr]$handle
    if (-not [DshNative]::IsWindow($hwnd)) { throw "no window has handle $handle" }
    return (Get-WindowInfo $handle)
  }
  if ([string]::IsNullOrWhiteSpace($query)) { throw 'focus_window needs title or handle' }
  $needle = $query.ToLowerInvariant()
  $match = $null
  foreach ($candidate in [DshNative]::TopLevelWindowHandles()) {
    $hwnd = [IntPtr]$candidate
    if (-not [DshNative]::IsWindow($hwnd)) { continue }
    if ($visibleOnly -and -not [DshNative]::IsWindowVisible($hwnd)) { continue }
    $title = [DshNative]::WindowTitle($hwnd)
    if ($title -eq '' -or -not $title.ToLowerInvariant().Contains($needle)) { continue }
    $info = Get-WindowInfo $candidate
    if (-not $visibleOnly) { return $info }
    if (-not $match -or ($info.bounds.width * $info.bounds.height) -gt ($match.bounds.width * $match.bounds.height)) { $match = $info }
  }
  if (-not $match) { throw "no visible window contains '$query' in its title" }
  return $match
}

# ── dispatch ──────────────────────────────────────────────────────────────────
# One request: it is validated, executed and the result object is returned. The
# caller decides whether to write it and exit (one-request mode) or to stay in the
# loop (server mode).
function Invoke-Request([string]$rawInput) {
if ([string]::IsNullOrWhiteSpace($rawInput)) { Throw-Fail 'I did not receive a JSON object on stdin' 3 }
try { $request = $rawInput | ConvertFrom-Json } catch { Throw-Fail "invalid JSON on stdin: $($_.Exception.Message)" 3 }

$action = [string]$request.action
if ([string]::IsNullOrWhiteSpace($action)) { Throw-Fail 'the action field is missing' 3 }

try {
  switch ($action) {
    'screenshot' {
      $maxWidth = if ($request.PSObject.Properties['maxWidth'] -and $request.maxWidth) { [int]$request.maxWidth } else { 1600 }
      $maxHeight = if ($request.PSObject.Properties['maxHeight'] -and $request.maxHeight) { [int]$request.maxHeight } else { 1000 }
      $result = Do-Screenshot $maxWidth $maxHeight
      Prune-Frames 5
    }
    'cursor' { $result = Do-Cursor }
    'windows' { $result = Do-Windows }
    'wait' {
      $ms = if ($request.PSObject.Properties['ms'] -and $request.ms) { [int]$request.ms } else { 500 }
      if ($ms -gt 30000) { throw 'wait accepts at most 30000 ms' }
      Wait-Ms $ms
      $result = [ordered]@{ ok = $true; action = 'wait'; waitedMs = $ms; ms = (Elapsed) }
    }
    'move' {
      $x = [int]$request.x; $y = [int]$request.y
      [void][DshNative]::SetCursorPos($x, $y)
      Wait-Ms 60
      $result = [ordered]@{ ok = $true; action = 'move'; x = $x; y = $y; ms = (Elapsed) }
    }
    { $_ -in @('click', 'double_click', 'right_click') } {
      $x = [int]$request.x; $y = [int]$request.y
      [void][DshNative]::SetCursorPos($x, $y)
      Wait-Ms 80
      if ($action -eq 'right_click') {
        [DshNative]::MouseClick([DshNative]::MOUSEEVENTF_RIGHTDOWN, [DshNative]::MOUSEEVENTF_RIGHTUP)
      } else {
        [DshNative]::MouseClick([DshNative]::MOUSEEVENTF_LEFTDOWN, [DshNative]::MOUSEEVENTF_LEFTUP)
        if ($action -eq 'double_click') { Wait-Ms 70; [DshNative]::MouseClick([DshNative]::MOUSEEVENTF_LEFTDOWN, [DshNative]::MOUSEEVENTF_LEFTUP) }
      }
      Wait-Ms 120
      $result = [ordered]@{ ok = $true; action = $action; x = $x; y = $y; ms = (Elapsed) }
    }
    'drag' {
      $x = [int]$request.x; $y = [int]$request.y
      $x2 = [int]$request.x2; $y2 = [int]$request.y2
      [void][DshNative]::SetCursorPos($x, $y)
      Wait-Ms 80
      [DshNative]::MouseClick([DshNative]::MOUSEEVENTF_LEFTDOWN, [DshNative]::MOUSEEVENTF_LEFTDOWN)
      $steps = 14
      for ($i = 1; $i -le $steps; $i++) {
        $ix = [int]($x + (($x2 - $x) * $i / $steps)); $iy = [int]($y + (($y2 - $y) * $i / $steps))
        [void][DshNative]::SetCursorPos($ix, $iy)
        Wait-Ms 12
      }
      [DshNative]::MouseClick([DshNative]::MOUSEEVENTF_LEFTUP, [DshNative]::MOUSEEVENTF_LEFTUP)
      Wait-Ms 120
      $result = [ordered]@{ ok = $true; action = 'drag'; from = [ordered]@{ x = $x; y = $y }; to = [ordered]@{ x = $x2; y = $y2 }; ms = (Elapsed) }
    }
    'scroll' {
      $amount = if ($request.PSObject.Properties['amount'] -and $request.amount) { [int]$request.amount } else { 3 }
      $horizontal = ($request.PSObject.Properties['horizontal'] -and [bool]$request.horizontal)
      $delta = [Math]::Max(-3000, [Math]::Min(3000, $amount * 120))
      [DshNative]::MouseWheel($delta, $horizontal)
      Wait-Ms 120
      $result = [ordered]@{ ok = $true; action = 'scroll'; amount = $amount; horizontal = $horizontal; ms = (Elapsed) }
    }
    'type' {
      $text = [string]$request.text
      if ([string]::IsNullOrEmpty($text)) { throw 'type needs text' }
      $perChar = if ($request.PSObject.Properties['delayMs'] -and $request.delayMs) { [int]$request.delayMs } else { 8 }
      foreach ($ch in $text.ToCharArray()) {
        $code = [int][char]$ch
        [void][DshNative]::Key(0, [uint16]$code, $false, $false)
        [void][DshNative]::Key(0, [uint16]$code, $true, $false)
        if ($perChar -gt 0) { Wait-Ms $perChar }
      }
      $result = [ordered]@{ ok = $true; action = 'type'; chars = $text.Length; ms = (Elapsed) }
    }
    'key' {
      $key = [string]$request.key
      Key-Press $key
      Wait-Ms 80
      $result = [ordered]@{ ok = $true; action = 'key'; key = $key; ms = (Elapsed) }
    }
    'keys' {
      $keys = @($request.keys)
      if ($keys.Count -eq 0) { throw 'keys needs a non-empty list' }
      # Two parallel lists of scalars: packing pairs into arrays inside a
      # PowerShell variable unwraps the array and breaks index [0].
      $vkeys = @()
      $vextended = @()
      foreach ($key in $keys) {
        $vkeys += [int](Resolve-Vk ([string]$key))
        $vextended += [bool]($script:ExtendedKeys -contains ([string]$key).Trim().ToUpperInvariant())
      }
      $pressed = 0
      try {
        for ($i = 0; $i -lt $vkeys.Count; $i++) {
          [void][DshNative]::Key([uint16]$vkeys[$i], 0, $false, [bool]$vextended[$i])
          $pressed++
        }
        Wait-Ms 40
      } finally {
        # Always release what was already pressed down, in reverse order, even if something fails.
        for ($i = $pressed - 1; $i -ge 0; $i--) {
          [void][DshNative]::Key([uint16]$vkeys[$i], 0, $true, [bool]$vextended[$i])
          Wait-Ms 15
        }
      }
      Wait-Ms 80
      $result = [ordered]@{ ok = $true; action = 'keys'; keys = @($keys); ms = (Elapsed) }
    }
    'focus_window' {
      $query = if ($request.PSObject.Properties['title']) { [string]$request.title } else { '' }
      $handle = if ($request.PSObject.Properties['handle']) { [int64]$request.handle } else { 0 }
      $info = Get-WindowByQuery $query $handle -visibleOnly
      $hwnd = [IntPtr]$info.handle
      if ($info.minimized) { [void][DshNative]::ShowWindow($hwnd, 9) }
      $focused = [DshNative]::SetForegroundWindow($hwnd)
      Wait-Ms 250
      $result = [ordered]@{
        ok = $true; action = 'focus_window'; title = $info.title; pid = $info.pid; process = $info.process
        handle = $info.handle; focused = [bool]$focused; bounds = $info.bounds; ms = (Elapsed)
      }
    }
    'close_window' {
      $query = if ($request.PSObject.Properties['title']) { [string]$request.title } else { '' }
      $handle = if ($request.PSObject.Properties['handle']) { [int64]$request.handle } else { 0 }
      $info = Get-WindowByQuery $query $handle
      [DshNative]::WindowClose([IntPtr]$info.handle)
      Wait-Ms 200
      $result = [ordered]@{ ok = $true; action = 'close_window'; title = $info.title; pid = $info.pid; handle = $info.handle; ms = (Elapsed) }
    }
    'start_app' {
      $result = Do-StartApp ([string]$request.app)
    }
    default { Throw-Fail "unknown action: '$action'" 3 $action }
  }

  # Optional trailing capture so one call shows its own result.
  if ($request.PSObject.Properties['captureAfter'] -and [bool]$request.captureAfter -and $action -ne 'screenshot') {
    Wait-Ms 200
    $maxWidth = if ($request.PSObject.Properties['maxWidth'] -and $request.maxWidth) { [int]$request.maxWidth } else { 1600 }
    $maxHeight = if ($request.PSObject.Properties['maxHeight'] -and $request.maxHeight) { [int]$request.maxHeight } else { 1000 }
    $shot = Do-Screenshot $maxWidth $maxHeight
    Prune-Frames 5
    $result = [ordered]@{ ok = $true; action = $action; outcome = $result; screenshot = $shot; ms = (Elapsed) }
  }

  return $result
} catch {
  $exception = $_.Exception
  $message = $exception.Message
  $inner = $exception.InnerException
  while ($inner) { $message = "$message <- $($inner.Message)"; $inner = $inner.InnerException }
  if ($exception -is [Fail]) { throw $exception }
  throw [Fail]::new("failure '$action': $message", 1, $action)
}
}
# ── end of Invoke-Request ─────────────────────────────────────────────────────

# ── main loop ─────────────────────────────────────────────────────────────────
Initialize-Native

# JSON reply on a single line: the Node process reads line by line.
function Write-Reply($payload) {
  [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress -Depth 8))
  [Console]::Out.Flush()
}

if ($Server) {
  # Persistent server: one request per line until stdin closes.
  # Startup is paid once and then each action costs milliseconds.
  $stdin = [Console]::In
  while ($true) {
    $line = $stdin.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim() -eq '') { continue }
    try {
      Write-Reply (Invoke-Request $line)
    } catch {
      $exception = $_.Exception
      $code = if ($exception -is [Fail]) { $exception.Code } else { 1 }
      $failedAction = if ($exception -is [Fail]) { $exception.Action } else { '' }
      $payload = [ordered]@{ ok = $false; error = $exception.Message; code = $code; ms = (Elapsed) }
      if ($failedAction) { $payload.action = $failedAction }
      Write-Reply $payload
    }
  }
  exit 0
}

# With no redirected stdin there is no request to read: better to fail clearly
# than to wait. It is the difference between a useful error and a hung process
# nobody watches (it happened during development).
if (-not [Console]::IsInputRedirected) {
  Throw-Fail 'this runner reads its JSON request from stdin; redirect a request (or use -Server for server mode) instead of launching it by hand' 3
}

$rawInput = [Console]::In.ReadToEnd()
try {
  Write-Reply (Invoke-Request $rawInput)
  exit 0
} catch {
  $exception = $_.Exception
  $code = if ($exception -is [Fail]) { $exception.Code } else { 1 }
  $failedAction = if ($exception -is [Fail]) { $exception.Action } else { '' }
  $payload = [ordered]@{ ok = $false; error = $exception.Message; code = $code; ms = (Elapsed) }
  if ($failedAction) { $payload.action = $failedAction }
  Write-Reply $payload
  exit $code
}

param(
  [Parameter(Mandatory = $true)][string]$App,
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = "Stop"

$lab = @{ Tile = 48; Slot = 64; Left = 24; Rows = @(96, 176); Rounds = 6; FadeMs = 250 }
$variants = @("plain", "blur", "layout", "blur+layout", "overlay", "plain later", "blur later", "layout later", "blur+layout later", "overlay later")
$probes = @("state", "setNativeProps", "inside background", "inside clear", "inside zIndex", "inside background+zIndex", "inside v1 panel", "helper background+zIndex")
$slots = $variants.Count + 1
$captureMs = 15000
$whiteAt = 220
$darkBelow = 30

if (-not ([System.Management.Automation.PSTypeName]"ArdiaFadeCheck").Type) {
  Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class ArdiaFadeCheck {
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct BitmapInfoHeader { public uint Size; public int Width, Height; public ushort Planes, BitCount; public uint Compression, SizeImage; public int XPelsPerMeter, YPelsPerMeter; public uint ClrUsed, ClrImportant; }
  delegate bool EnumWindowsCallback(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int max);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref Point point);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window, IntPtr dc);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BitmapInfoHeader header, uint usage, out IntPtr bits, IntPtr section, uint offset);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr item);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr item);
  [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr dc, int x, int y, int width, int height, IntPtr source, int sx, int sy, uint op);

  public class Sample { public long Ms; public int[] Values; }
  public class Shot { public long Ms; public int Width; public int Height; public byte[] Pixels; public string Front; }
  public class Run { public long WindowMs = -1; public double Scale = 1; public List<Sample> Samples = new List<Sample>(); public List<Shot> Shots = new List<Shot>(); public Process Process; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();

  static string Describe(IntPtr window, uint process) {
    if (window == IntPtr.Zero) return "none";
    uint owner;
    GetWindowThreadProcessId(window, out owner);
    StringBuilder name = new StringBuilder(64);
    GetClassName(window, name, 64);
    return name.ToString() + (owner == process ? " (ours)" : " (pid " + owner + ")");
  }

  static Shot Whole(IntPtr window, IntPtr screen, IntPtr memory, long at, uint process) {
    Rect client;
    GetClientRect(window, out client);
    Point origin = new Point();
    ClientToScreen(window, ref origin);
    Shot shot = new Shot();
    shot.Ms = at;
    shot.Width = client.Right - client.Left;
    shot.Height = client.Bottom - client.Top;
    shot.Front = Describe(GetForegroundWindow(), process);
    if (shot.Width < 8 || shot.Height < 8) return shot;
    BitmapInfoHeader header = new BitmapInfoHeader();
    header.Size = (uint)Marshal.SizeOf(typeof(BitmapInfoHeader));
    header.Width = shot.Width;
    header.Height = -shot.Height;
    header.Planes = 1;
    header.BitCount = 32;
    IntPtr bits;
    IntPtr section = CreateDIBSection(screen, ref header, 0, out bits, IntPtr.Zero, 0);
    if (section == IntPtr.Zero) return shot;
    IntPtr previous = SelectObject(memory, section);
    if (BitBlt(memory, 0, 0, shot.Width, shot.Height, screen, origin.X, origin.Y, 0x40CC0020)) {
      shot.Pixels = new byte[shot.Width * shot.Height * 4];
      Marshal.Copy(bits, shot.Pixels, 0, shot.Pixels.Length);
    }
    SelectObject(memory, previous);
    DeleteObject(section);
    return shot;
  }

  static IntPtr Find(uint process) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate (IntPtr window, IntPtr data) {
      uint owner;
      GetWindowThreadProcessId(window, out owner);
      if (owner != process || !IsWindowVisible(window)) return true;
      StringBuilder name = new StringBuilder(64);
      GetClassName(window, name, 64);
      if (name.ToString() != "Microsoft.UI.Windowing.Window") return true;
      found = window;
      return false;
    }, IntPtr.Zero);
    return found;
  }

  public class Grid { public long Ms; public int[] Values; }
  public class GridRun { public long WindowMs = -1; public List<Grid> Frames = new List<Grid>(); public Process Process; public List<string> Fronts = new List<string>(); }

  public static GridRun CaptureGrid(string app, string arguments, int milliseconds) {
    SetProcessDPIAware();
    GridRun run = new GridRun();
    Stopwatch clock = Stopwatch.StartNew();
    ProcessStartInfo start = new ProcessStartInfo(app, arguments);
    start.UseShellExecute = false;
    run.Process = Process.Start(start);
    IntPtr window = IntPtr.Zero;
    IntPtr screen = GetDC(IntPtr.Zero);
    IntPtr memory = CreateCompatibleDC(screen);
    try {
      while (clock.ElapsedMilliseconds < milliseconds && !run.Process.HasExited) {
        if (window == IntPtr.Zero) {
          window = Find((uint)run.Process.Id);
          if (window == IntPtr.Zero) { Thread.Sleep(1); continue; }
          run.WindowMs = clock.ElapsedMilliseconds;
        }
        long at = clock.ElapsedMilliseconds;
        if (run.Fronts.Count < (at - run.WindowMs) / 1000 + 1) run.Fronts.Add(Describe(GetForegroundWindow(), (uint)run.Process.Id));
        Shot shot = Whole(window, screen, memory, at - run.WindowMs, (uint)run.Process.Id);
        if (shot.Pixels == null) { Thread.Sleep(2); continue; }
        Grid grid = new Grid();
        grid.Ms = at - run.WindowMs;
        grid.Values = new int[960];
        for (int row = 0; row < 24; row++) {
          for (int column = 0; column < 40; column++) {
            int x = (int)((column + 0.5) * shot.Width / 40), y = (int)((row + 0.5) * shot.Height / 24);
            int i = (y * shot.Width + x) * 4;
            grid.Values[row * 40 + column] = (shot.Pixels[i] + shot.Pixels[i + 1] + shot.Pixels[i + 2]) / 3;
          }
        }
        run.Frames.Add(grid);
      }
    } finally {
      DeleteDC(memory);
      ReleaseDC(IntPtr.Zero, screen);
    }
    return run;
  }

  public static double Same(int[] a, int[] b) {
    int same = 0;
    for (int i = 0; i < a.Length; i++) if (Math.Abs(a[i] - b[i]) <= 6) same++;
    return same / (double)a.Length;
  }

  public static Run Capture(string app, string arguments, int milliseconds, int tiles, int left, int slot, int tile, int[] tops) {
    SetProcessDPIAware();
    Run run = new Run();
    Stopwatch clock = Stopwatch.StartNew();
    ProcessStartInfo start = new ProcessStartInfo(app, arguments);
    start.UseShellExecute = false;
    run.Process = Process.Start(start);
    IntPtr window = IntPtr.Zero;
    IntPtr screen = GetDC(IntPtr.Zero);
    IntPtr memory = CreateCompatibleDC(screen);
    IntPtr section = IntPtr.Zero, bits = IntPtr.Zero, previous = IntPtr.Zero;
    int width = 0, x0 = 0;
    int[] ys = new int[tops.Length];
    int[] xs = new int[tiles];
    long[] shotsAt = new long[] { 300, 900, 1500, 2600, 4500 };
    int nextShot = 0;
    IntPtr shotMemory = CreateCompatibleDC(screen);
    try {
      while (clock.ElapsedMilliseconds < milliseconds && !run.Process.HasExited) {
        if (window == IntPtr.Zero) {
          window = Find((uint)run.Process.Id);
          if (window == IntPtr.Zero) { Thread.Sleep(1); continue; }
          run.WindowMs = clock.ElapsedMilliseconds;
          run.Scale = GetDpiForWindow(window) / 96.0;
          Point origin = new Point();
          ClientToScreen(window, ref origin);
          x0 = origin.X + (int)(left * run.Scale);
          width = (int)(tiles * slot * run.Scale);
          for (int r = 0; r < tops.Length; r++) ys[r] = origin.Y + (int)((tops[r] + tile / 2) * run.Scale);
          for (int i = 0; i < tiles; i++) xs[i] = (int)((i * slot + tile / 2) * run.Scale);
          BitmapInfoHeader header = new BitmapInfoHeader();
          header.Size = (uint)Marshal.SizeOf(typeof(BitmapInfoHeader));
          header.Width = width;
          header.Height = -1;
          header.Planes = 1;
          header.BitCount = 32;
          section = CreateDIBSection(screen, ref header, 0, out bits, IntPtr.Zero, 0);
          previous = SelectObject(memory, section);
        }
        long at = clock.ElapsedMilliseconds;
        if (nextShot < shotsAt.Length && at - run.WindowMs >= shotsAt[nextShot]) {
          run.Shots.Add(Whole(window, screen, shotMemory, at - run.WindowMs, (uint)run.Process.Id));
          nextShot++;
          continue;
        }
        Sample sample = new Sample();
        sample.Ms = at;
        sample.Values = new int[tiles * ys.Length];
        bool read = true;
        for (int r = 0; r < ys.Length && read; r++) {
          if (!BitBlt(memory, 0, 0, width, 1, screen, x0, ys[r], 0x40CC0020)) { read = false; break; }
          byte[] row = new byte[width * 4];
          Marshal.Copy(bits, row, 0, row.Length);
          for (int i = 0; i < tiles; i++) {
            int p = xs[i] * 4;
            sample.Values[r * tiles + i] = (row[p] + row[p + 1] + row[p + 2]) / 3;
          }
        }
        if (!read) { Thread.Sleep(1); continue; }
        run.Samples.Add(sample);
        Thread.Sleep(2);
      }
    } finally {
      if (section != IntPtr.Zero) { SelectObject(memory, previous); DeleteObject(section); }
      DeleteDC(memory);
      DeleteDC(shotMemory);
      ReleaseDC(IntPtr.Zero, screen);
    }
    return run;
  }
}
"@
}

function Measure-Fades([string]$Label, [switch]$Onboarded) {
  $data = Join-Path $Out "fade-$Label-data"
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $data
  New-Item -ItemType Directory -Force -Path $data | Out-Null
  if ($Onboarded) { Set-Content -LiteralPath (Join-Path $data "onboarding.json") -Value '{"completedAt":1700000000000,"version":1}' -Encoding utf8NoBOM }
  $log = Join-Path $Out "fade-$Label.log"
  Remove-Item -Force -ErrorAction SilentlyContinue $log
  $env:ARDIA_DATA_DIR = $data
  $env:ARDIA_BACKGROUND = ""
  $env:ARDIA_TEST = "fadeLab=1"
  try {
    $run = [ArdiaFadeCheck]::Capture($App, "--log-file=`"$log`"", $captureMs, $slots, $lab.Left, $lab.Slot, $lab.Tile, [int[]]$lab.Rows)
  } finally {
    $env:ARDIA_TEST = ""
  }
  if ($run.Process -and -not $run.Process.HasExited) { Stop-Process -Id $run.Process.Id -Force -ErrorAction SilentlyContinue }
  Add-Type -AssemblyName System.Drawing
  foreach ($shot in @($run.Shots)) {
    Write-Host "fades, $Label`: shot at $($shot.Ms) ms after the window, $($shot.Width)x$($shot.Height), in front: $($shot.Front)"
    if (-not $shot.Pixels) { continue }
    $bitmap = [System.Drawing.Bitmap]::new($shot.Width, $shot.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppRgb)
    $box = [System.Drawing.Rectangle]::new(0, 0, $shot.Width, $shot.Height)
    $locked = $bitmap.LockBits($box, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, $bitmap.PixelFormat)
    [System.Runtime.InteropServices.Marshal]::Copy($shot.Pixels, 0, $locked.Scan0, $shot.Pixels.Length)
    $bitmap.UnlockBits($locked)
    $bitmap.Save((Join-Path $Out ("fade-$Label-{0:00000}ms.png" -f $shot.Ms)), [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
  }
  $csv = [System.Text.StringBuilder]::new()
  [void]$csv.AppendLine("ms," + ((@("marker") + $variants + $probes + @(1..($slots - $probes.Count) | ForEach-Object { "row2-$_" })) -join ","))
  foreach ($sample in @($run.Samples)) { [void]$csv.AppendLine("$($sample.Ms - $run.WindowMs)," + ($sample.Values -join ",")) }
  Set-Content -LiteralPath (Join-Path $Out "fade-$Label-samples.csv") -Value $csv.ToString() -Encoding utf8NoBOM
  Start-Sleep -Milliseconds 800
  $problems = @()
  $samples = @($run.Samples)
  $shots = @($run.Shots)
  $covered = @($shots | Where-Object { $_.Front -notmatch "\(ours\)" })
  if ($shots.Count -and $covered.Count -eq $shots.Count) {
    Write-Host "fades, $Label`: unverified, another window was in front for every shot ($($covered[0].Front))"
    return @()
  }
  Write-Host "fades, $Label`: window at $($run.WindowMs) ms, scale $($run.Scale), $($samples.Count) samples"
  if ($samples.Count -lt 100) { return @("fades, $Label`: only $($samples.Count) samples were captured") }
  $intervals = @()
  $on = $null
  foreach ($sample in $samples) {
    $marked = $sample.Values[0] -ge $whiteAt
    if ($marked -and $null -eq $on) { $on = $sample.Ms }
    if (-not $marked -and $null -ne $on -and $sample.Values[0] -lt $darkBelow) { $intervals += , @($on, $sample.Ms); $on = $null }
  }
  if ($null -ne $on) { $intervals += , @($on, $samples[-1].Ms) }
  Write-Host "fades, $Label`: $($intervals.Count) rounds seen by the marker"
  if ($intervals.Count -lt $lab.Rounds) { $problems += "fades, $Label`: the marker showed $($intervals.Count) rounds, not $($lab.Rounds)" }
  $byRound = @($intervals | ForEach-Object { $from = $_[0]; $to = $_[1]; , @($samples | Where-Object { $_.Ms -ge $from -and $_.Ms -lt $to }) })
  $columns = @()
  for ($v = 0; $v -lt $variants.Count; $v++) { $columns += [pscustomobject]@{ Name = $variants[$v]; Column = $v + 1; Gates = $true } }
  for ($v = 0; $v -lt $probes.Count; $v++) { $columns += [pscustomobject]@{ Name = $probes[$v]; Column = $slots + $v; Gates = ($probes[$v] -eq "helper background+zIndex") } }
  $rawColumn = $slots + [array]::IndexOf($probes, "inside background+zIndex")
  $rawMissed = 0
  for ($r = 1; $r -lt $intervals.Count; $r++) {
    $rawWhite = @($byRound[$r] | Where-Object { $_.Values[$rawColumn] -ge $whiteAt })
    if ($rawWhite.Count -eq 0) { $rawMissed++ }
  }
  Write-Host "fades, $Label`: a raw view with a background and zIndex still hides a child mounted later in $rawMissed of $([Math]::Max(0, $intervals.Count - 1)) rounds (React Native Windows 0.81.38 ViewComponentView::MountChildComponentView); when this reads 0, BackedView can go"
  foreach ($entry in $columns) {
    $column = $entry.Column
    $rows = @()
    for ($r = 0; $r -lt $intervals.Count; $r++) {
      $round = $r + 1
      $interval = $intervals[$r]
      $inRound = $byRound[$r]
      $between = @($inRound | Where-Object { $_.Values[$column] -gt $darkBelow -and $_.Values[$column] -lt $whiteAt })
      $white = @($inRound | Where-Object { $_.Values[$column] -ge $whiteAt }) | Select-Object -First 1
      $landed = if ($white) { [int]($white.Ms - $interval[0]) } else { $null }
      $last = if ($inRound.Count) { $inRound[-1].Values[$column] } else { -1 }
      $rows += [pscustomobject]@{ Round = $round; Between = $between.Count; Landed = $landed; Last = $last; Shown = [int]($interval[1] - $interval[0]) }
      if ($null -eq $landed) { if ($entry.Gates) { $problems += "fades, $Label, $($entry.Name), round $round`: never reached white in $([int]($interval[1] - $interval[0])) ms (last $last)" } }
      elseif ($entry.Gates -and $round -gt 1 -and $between.Count -eq 0) { $problems += "fades, $Label, $($entry.Name), round $round`: no in-between frame; white at $landed ms" }
    }
    $summary = ($rows | ForEach-Object { if ($null -eq $_.Landed) { "r$($_.Round) never (last $($_.Last))" } else { "r$($_.Round) $($_.Between) between, white at $($_.Landed) ms" } }) -join "; "
    Write-Host "fades, $Label, $($entry.Name): $summary"
  }
  if (Test-Path $log) { Select-String -Path $log -Pattern "fade lab round 1 " | Select-Object -First 4 | ForEach-Object { Write-Host "fades, $Label log: $($_.Line)" } }
  return $problems
}

function Measure-Overlay([string]$Label, [switch]$Onboarded, [string]$Test, [int]$Milliseconds = 9000) {
  $data = Join-Path $Out "overlay-$Label-data"
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $data
  New-Item -ItemType Directory -Force -Path $data | Out-Null
  if ($Onboarded) { Set-Content -LiteralPath (Join-Path $data "onboarding.json") -Value '{"completedAt":1700000000000,"version":1}' -Encoding utf8NoBOM }
  $log = Join-Path $Out "overlay-$Label.log"
  Remove-Item -Force -ErrorAction SilentlyContinue $log
  $env:ARDIA_DATA_DIR = $data
  $env:ARDIA_BACKGROUND = ""
  $env:ARDIA_TEST = $Test
  try { $run = [ArdiaFadeCheck]::CaptureGrid($App, "--log-file=`"$log`"", $Milliseconds) } finally { $env:ARDIA_TEST = "" }
  if ($run.Process -and -not $run.Process.HasExited) { Stop-Process -Id $run.Process.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 800
  $marks = if (Test-Path $log) { @(Select-String -Path $log -Pattern "\[ardia overlay\]" | ForEach-Object { $_.Line -replace '^\S+ (\d+) \[ardia overlay\] ', '$1 ' }) } else { @() }
  Write-Host "overlay, $Label`: window at $($run.WindowMs) ms, $($run.Frames.Count) frames, in front each second: $(($run.Fronts | Select-Object -Unique) -join ' / ')"
  Write-Host "overlay, $Label marks (ms since launch): $($marks -join ' | ')"
  return $run
}

function Write-OverlayTimeline([string]$Label, $Run, [int[]]$Browser) {
  $spans = @()
  $current = $null
  foreach ($frame in @($Run.Frames)) {
    $kind = if ([ArdiaFadeCheck]::Same($frame.Values, $Browser) -ge 0.9) { "browser" } else { "covered" }
    if ($null -eq $current -or $current.Kind -ne $kind) {
      if ($current) { $spans += $current }
      $current = [pscustomobject]@{ Kind = $kind; From = $frame.Ms; To = $frame.Ms }
    } else { $current.To = $frame.Ms }
  }
  if ($current) { $spans += $current }
  Write-Host "overlay, $Label timeline (ms after the window, browser = 90% of 960 points within 6 of the browser before onboarding): $(($spans | ForEach-Object { "$($_.Kind) $($_.From)-$($_.To)" }) -join ', ')"
}

$found = @()
$late = Measure-Overlay "late" -Onboarded -Test "onboardingLateMs=3000,overlayMarks=1"
$lateOpaque = Measure-Overlay "late-opaque" -Onboarded -Test "onboardingLateMs=3000,overlayMarks=1,overlayNoFade=1"
$firstLaunch = Measure-Overlay "first-launch" -Test "overlayMarks=1"
$before = @($late.Frames | Where-Object { $_.Ms -ge 1800 -and $_.Ms -le 2300 }) | Select-Object -Last 1
if ($before) {
  Write-OverlayTimeline "late" $late $before.Values
  Write-OverlayTimeline "late-opaque" $lateOpaque $before.Values
  Write-OverlayTimeline "first-launch" $firstLaunch $before.Values
} else { Write-Host "overlay: no browser frame before the late onboarding to compare with" }
$found += Measure-Fades "first-launch"
$found += Measure-Fades "onboarded" -Onboarded
$env:ARDIA_DATA_DIR = ""
return $found

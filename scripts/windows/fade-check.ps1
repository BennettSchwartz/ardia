param(
  [Parameter(Mandatory = $true)][string]$App,
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = "Stop"

$lab = @{ Tile = 48; Slot = 64; Left = 24; Top = 96; Rounds = 6; FadeMs = 250 }
$variants = @("plain", "blur", "layout", "blur+layout", "overlay", "plain later", "blur later", "layout later", "blur+layout later", "overlay later")
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
  public class Run { public long WindowMs = -1; public double Scale = 1; public List<Sample> Samples = new List<Sample>(); public Process Process; }

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

  public static Run Capture(string app, string arguments, int milliseconds, int tiles, int left, int slot, int tile, int top) {
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
    int width = 0, y = 0, x0 = 0;
    int[] xs = new int[tiles];
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
          y = origin.Y + (int)((top + tile / 2) * run.Scale);
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
        if (!BitBlt(memory, 0, 0, width, 1, screen, x0, y, 0x40CC0020)) { Thread.Sleep(1); continue; }
        byte[] row = new byte[width * 4];
        Marshal.Copy(bits, row, 0, row.Length);
        Sample sample = new Sample();
        sample.Ms = at;
        sample.Values = new int[tiles];
        for (int i = 0; i < tiles; i++) {
          int p = xs[i] * 4;
          sample.Values[i] = (row[p] + row[p + 1] + row[p + 2]) / 3;
        }
        run.Samples.Add(sample);
        Thread.Sleep(2);
      }
    } finally {
      if (section != IntPtr.Zero) { SelectObject(memory, previous); DeleteObject(section); }
      DeleteDC(memory);
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
    $run = [ArdiaFadeCheck]::Capture($App, "--log-file=`"$log`"", $captureMs, $variants.Count + 1, $lab.Left, $lab.Slot, $lab.Tile, $lab.Top)
  } finally {
    $env:ARDIA_TEST = ""
  }
  if ($run.Process -and -not $run.Process.HasExited) { Stop-Process -Id $run.Process.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 800
  $problems = @()
  $samples = @($run.Samples)
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
  for ($v = 0; $v -lt $variants.Count; $v++) {
    $column = $v + 1
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
      if ($null -eq $landed) { $problems += "fades, $Label, $($variants[$v]), round $round`: never reached white in $([int]($interval[1] - $interval[0])) ms (last $last)" }
      elseif ($round -gt 1 -and $between.Count -eq 0) { $problems += "fades, $Label, $($variants[$v]), round $round`: no in-between frame; white at $landed ms" }
    }
    $summary = ($rows | ForEach-Object { if ($null -eq $_.Landed) { "r$($_.Round) never (last $($_.Last))" } else { "r$($_.Round) $($_.Between) between, white at $($_.Landed) ms" } }) -join "; "
    Write-Host "fades, $Label, $($variants[$v]): $summary"
  }
  if (Test-Path $log) { Select-String -Path $log -Pattern "fade lab round 1 " | Select-Object -First 4 | ForEach-Object { Write-Host "fades, $Label log: $($_.Line)" } }
  return $problems
}

$found = @()
$found += Measure-Fades "first-launch"
$found += Measure-Fades "onboarded" -Onboarded
$env:ARDIA_DATA_DIR = ""
return $found

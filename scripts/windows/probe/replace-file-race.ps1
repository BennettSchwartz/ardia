param([int]$Seconds = 20)
$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
public static class ReplaceRace {
  [StructLayout(LayoutKind.Sequential)] struct Attributes { public uint FileAttributes; public long Created; public long Accessed; public long Written; public uint SizeHigh; public uint SizeLow; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct FindData { public uint FileAttributes; public long Created; public long Accessed; public long Written; public uint SizeHigh; public uint SizeLow; public uint Reserved0; public uint Reserved1; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string Alternate; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool GetFileAttributesExW(string name, int level, out Attributes data);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr FindFirstFileW(string name, out FindData data);
  [DllImport("kernel32.dll")] static extern bool FindClose(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ReplaceFileW(string replaced, string replacement, string backup, uint flags, IntPtr exclude, IntPtr reserved);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool MoveFileW(string from, string to);
  public static string Run(string folder, int seconds) {
    string target = Path.Combine(folder, "Local State");
    File.WriteAllText(target, "{}");
    var stop = DateTime.UtcNow.AddSeconds(seconds);
    long writes = 0, replaceFailures = 0, moves = 0;
    var writer = new Thread(() => {
      int n = 0;
      while (DateTime.UtcNow < stop) {
        string temp = Path.Combine(folder, "Local State~RF" + (n++ % 4) + ".TMP");
        File.WriteAllText(temp, "{\"n\":" + n + ",\"pad\":\"" + new string('x', 4096) + "\"}");
        if (!ReplaceFileW(target, temp, null, 2, IntPtr.Zero, IntPtr.Zero)) { replaceFailures++; if (MoveFileW(temp, target)) moves++; }
        writes++;
      }
    });
    writer.Start();
    long reads = 0, attributeFailures = 0, findFailures = 0, notFile = 0;
    var attributeErrors = new Dictionary<int, long>();
    var findErrors = new Dictionary<int, long>();
    while (DateTime.UtcNow < stop) {
      reads++;
      Attributes data;
      if (!GetFileAttributesExW(target, 0, out data)) {
        int code = Marshal.GetLastWin32Error();
        attributeFailures++;
        attributeErrors[code] = (attributeErrors.ContainsKey(code) ? attributeErrors[code] : 0) + 1;
      } else if ((data.FileAttributes & 0x10) != 0) notFile++;
      FindData found;
      IntPtr handle = FindFirstFileW(target, out found);
      if (handle == new IntPtr(-1)) {
        int code = Marshal.GetLastWin32Error();
        findFailures++;
        findErrors[code] = (findErrors.ContainsKey(code) ? findErrors[code] : 0) + 1;
      } else FindClose(handle);
    }
    writer.Join();
    var parts = new List<string>();
    foreach (var pair in attributeErrors) parts.Add("attributes error " + pair.Key + " x" + pair.Value);
    foreach (var pair in findErrors) parts.Add("listing error " + pair.Key + " x" + pair.Value);
    return string.Format("{0} replaces ({1} ReplaceFile failures, {2} fell back to MoveFile); {3} reads: {4} attribute reads failed, {5} listings failed, {6} not a file; {7}", writes, replaceFailures, moves, reads, attributeFailures, findFailures, notFile, string.Join(", ", parts));
  }
}
"@
$folder = Join-Path $env:RUNNER_TEMP "replace-race"
New-Item -ItemType Directory -Force -Path $folder | Out-Null
Write-Host "ReplaceFile race on $env:PROCESSOR_ARCHITECTURE for $Seconds s: $([ReplaceRace]::Run($folder, $Seconds))"

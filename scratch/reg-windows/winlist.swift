import CoreGraphics
import Foundation
let pid = Int32(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
for w in list where (w[kCGWindowOwnerPID as String] as? Int32) == pid {
  let b = w[kCGWindowBounds as String] as! [String: Any]
  let num = w[kCGWindowNumber as String] as! Int
  let layer = w[kCGWindowLayer as String] as! Int
  let on = (w[kCGWindowIsOnscreen as String] as? Bool) ?? false
  let alpha = w[kCGWindowAlpha as String] as? Double ?? -1
  let name = w[kCGWindowName as String] as? String ?? "-"
  print(String(format: "#%-6d L%-4d %@ a=%.2f %4.0fx%-4.0f @%.0f,%.0f %@", num, layer, on ? "ON " : "off", alpha, (b["Width"] as! Double), (b["Height"] as! Double), (b["X"] as! Double), (b["Y"] as! Double), name))
}
